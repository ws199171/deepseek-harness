/**
 * The durable project memory store.
 *
 * One directory per project under the Harness home, one markdown file per entry.
 * Files rather than a key-value domain because the entry bodies are prose a person
 * is expected to read and edit, and because deleting the directory is then a
 * complete and self-evident way to forget everything.
 *
 * There is deliberately no derived index file. Listing scans the directory, which
 * keeps a single source of truth for content and removes the question of what to
 * do when a cache and its source disagree.
 *
 * @module dsh-context-ledger/store
 */

import { errorMessage } from './errors.ts'

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { orderRows, parseArchiveRow, serializeArchiveRow, type ArchiveRow } from './archive.ts'
import { compareEntries, parseEntry, serializeEntry, type Entry, type EntryKind, type EntryTier } from './entry.ts'

/** Directory under the Harness home holding every project's ledger. */
export const LEDGER_DIR = 'context-ledger'

/**
 * Entry ids the store will accept.
 *
 * Ids arrive from the model, so they are validated before being joined onto a
 * path: an id containing a separator or `..` would otherwise let a tool call
 * address a file outside the memory directory.
 */
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u

/**
 * Longest session id the archive will accept, before it is hashed to a file name.
 *
 * Ids come from the session rather than from the model, but an unbounded one would
 * still make an unbounded file name, so the length is bounded and the characters
 * are sanitized rather than trusted.
 */
const MAX_SESSION_ID_CHARS = 512

/**
 * One file's outcome, discriminated so a skipped file always carries its reason.
 *
 * @typeParam T - What a readable file parsed into.
 */
type FileOutcome<T> =
  | { readonly ok: true; readonly file: string; readonly value: T }
  | { readonly ok: false; readonly file: string; readonly reason: string }

/** A file the store could not use, and why. */
export interface SkippedFile {
  /** The file's name within its directory. */
  readonly file: string
  /** Why it was not usable. */
  readonly reason: string
}

/** Every stored entry, plus why any file was skipped. */
export interface StoreListing {
  /** The well-formed entries. */
  readonly entries: Entry[]
  /** Files that were not well-formed entries. */
  readonly skipped: SkippedFile[]
}

/** Every stored archive row, newest first, plus why any file was skipped. */
export interface ArchiveListing {
  /** The well-formed rows, newest first. */
  readonly rows: ArchiveRow[]
  /** Files that were not well-formed rows. */
  readonly skipped: SkippedFile[]
}

/** The outcome of reading one entry by id. */
export type StoreGetResult =
  | { readonly ok: true; readonly entry: Entry }
  | { readonly ok: false; readonly reason: string }

/** One search hit, carrying an excerpt rather than the whole body. */
export interface SearchMatch {
  /** The entry id. */
  readonly id: string
  /** The entry kind. */
  readonly kind: EntryKind
  /** The entry tier. */
  readonly tier: EntryTier
  /** The entry headline. */
  readonly title: string
  /** A bounded window of the body around the matched term. */
  readonly excerpt: string
}

/** Ranked search hits, the true match count, and any files skipped while listing. */
export interface SearchResult {
  /** The returned hits, best first. */
  readonly matches: SearchMatch[]
  /** How many entries matched, before the limit was applied. */
  readonly total: number
  /** Files that were not well-formed entries. */
  readonly skipped: SkippedFile[]
}

/** The store handle for one project. */
export interface LedgerStore {
  /** Absolute directory holding this project's ledger files. */
  readonly projectDir: string
  /** Absolute directory holding entries. */
  readonly memoryDir: string
  /** Absolute directory holding archive rows. */
  readonly archiveDir: string
  /** List every well-formed entry. */
  readonly list: () => Promise<StoreListing>
  /** Read one entry by id. */
  readonly get: (id: string) => Promise<StoreGetResult>
  /** Write one entry durably, replacing any file with its id. */
  readonly put: (entry: Entry) => Promise<Entry>
  /** Search titles and bodies for a substring. */
  readonly search: (query: string, limit: number, excerptChars: number) => Promise<SearchResult>
  /** Store one archived session row, replacing any row for the same session. */
  readonly putArchiveRow: (row: ArchiveRow) => Promise<ArchiveRow>
  /** List every well-formed archive row, newest first. */
  readonly listArchive: () => Promise<ArchiveListing>
}

/**
 * Derive the archive file name for one session.
 *
 * The readable prefix makes the directory identifiable while debugging; the hash
 * is what identifies it, so sanitizing an id cannot collide with a different id
 * that sanitized to the same text.
 *
 * @param sessionId - The session id.
 * @returns A filesystem-safe, collision-resistant file name.
 */
export function archiveFileName(sessionId: string): string {
  const safe = sessionId
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/^[._-]+/u, '')
    .slice(0, 64)
  const hash = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 8)
  return `${safe.length > 0 ? safe : 'session'}-${hash}.json`
}

/**
 * Derive the directory name for one project.
 *
 * The readable prefix makes the directory identifiable while debugging; the hash
 * is what actually identifies it, so two projects sharing a directory name do not
 * collide and a checkout moved to a new path becomes a new project.
 *
 * @param projectRoot - The resolved project root.
 * @returns A filesystem-safe, collision-resistant key.
 */
export function projectKey(projectRoot: string): string {
  const name = basename(projectRoot)
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32)
  const hash = createHash('sha256').update(projectRoot, 'utf8').digest('hex').slice(0, 12)
  return `${name.length > 0 ? name : 'project'}-${hash}`
}

/**
 * Read one file without letting a single unreadable file fail a listing.
 *
 * @param path - Absolute file path.
 * @returns The contents, or the reason they could not be read.
 */
async function readTextFile(path: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  try {
    return { ok: true, text: await readFile(path, 'utf8') }
  } catch (error) {
    // A file that cannot be read is skipped; one bad file must not hide the rest.
    return { ok: false, reason: errorMessage(error) }
  }
}

/**
 * Whether an error is the "directory does not exist yet" case.
 *
 * @param error - The caught value.
 * @returns True when the path is simply absent.
 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Open the store for one project.
 *
 * @param request - The store request.
 * @param request.home - The resolved Harness home.
 * @param request.projectRoot - The resolved project root.
 * @returns The store handle.
 */
export function createStore(request: { home: string; projectRoot: string }): LedgerStore {
  const { home, projectRoot } = request
  const projectDir = join(home, LEDGER_DIR, 'projects', projectKey(projectRoot))
  const memoryDir = join(projectDir, 'memory')
  const archiveDir = join(projectDir, 'archive')
  let writeCounter = 0

  /**
   * Write a file durably: a temporary sibling renamed into place, so a reader
   * never observes a half-written file and an interrupted write leaves the
   * previous contents intact.
   *
   * @param directory - The target directory.
   * @param fileName - The target file name.
   * @param text - The contents.
   * @returns Resolves once the file is in place.
   */
  async function writeAtomically(directory: string, fileName: string, text: string): Promise<void> {
    await mkdir(directory, { recursive: true })
    const target = join(directory, fileName)
    const temp = join(directory, `.${fileName}.${process.pid}.${writeCounter++}.tmp`)
    await writeFile(temp, text, 'utf8')
    try {
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  /**
   * List every well-formed entry, plus why any file was skipped.
   *
   * @returns The listing.
   */
  async function list(): Promise<StoreListing> {
    let names: string[]
    try {
      names = await readdir(memoryDir)
    } catch (error) {
      if (isMissing(error)) return { entries: [], skipped: [] }
      throw error
    }
    const files = names.filter(name => name.endsWith('.md')).sort()
    const results = await Promise.all(files.map(async (file): Promise<FileOutcome<Entry>> => {
      const read = await readTextFile(join(memoryDir, file))
      if (!read.ok) return { ok: false, file, reason: read.reason }
      const parsed = parseEntry(read.text)
      return parsed.ok ? { ok: true, file, value: parsed.entry } : { ok: false, file, reason: parsed.reason }
    }))
    const entries: Entry[] = []
    const skipped: SkippedFile[] = []
    for (const result of results) {
      if (result.ok) entries.push(result.value)
      else skipped.push({ file: result.file, reason: result.reason })
    }
    return { entries, skipped }
  }

  /**
   * Read one entry by id.
   *
   * @param id - The entry id.
   * @returns The entry, or the reason it is unavailable.
   */
  async function get(id: string): Promise<StoreGetResult> {
    if (!ENTRY_ID_RE.test(id)) return { ok: false, reason: `invalid entry id ${JSON.stringify(id)}` }
    const read = await readTextFile(join(memoryDir, `${id}.md`))
    if (!read.ok) return { ok: false, reason: `no entry ${JSON.stringify(id)}` }
    const parsed = parseEntry(read.text)
    return parsed.ok ? { ok: true, entry: parsed.entry } : { ok: false, reason: `entry ${id}: ${parsed.reason}` }
  }

  /**
   * Write an entry durably.
   *
   * The write lands in a temporary sibling and is renamed into place, so a reader
   * never observes a half-written entry and an interrupted write leaves the
   * previous contents intact.
   *
   * @param entry - The entry to store.
   * @returns The stored entry.
   */
  async function put(entry: Entry): Promise<Entry> {
    await writeAtomically(memoryDir, `${entry.id}.md`, serializeEntry(entry))
    return entry
  }

  /**
   * Search titles and bodies for a substring.
   *
   * @param query - The needle; an empty needle matches nothing.
   * @param limit - Maximum matches to return.
   * @param excerptChars - Maximum characters of body excerpt per match.
   * @returns Ranked matches and the true match count.
   */
  async function search(query: string, limit: number, excerptChars: number): Promise<SearchResult> {
    const needle = query.trim().toLowerCase()
    const { entries, skipped } = await list()
    if (needle.length === 0) return { matches: [], total: 0, skipped }
    const matched = entries
      .filter(entry => entry.title.toLowerCase().includes(needle) || entry.body.toLowerCase().includes(needle))
      .sort(compareEntries)
    const matches = matched.slice(0, limit).map(entry => ({
      id: entry.id,
      kind: entry.kind,
      tier: entry.tier,
      title: entry.title,
      excerpt: excerptOf(entry.body, needle, excerptChars),
    }))
    return { matches, total: matched.length, skipped }
  }

  /**
   * Store one archived session row, replacing any row for the same session.
   *
   * Re-archiving a session is expected rather than exceptional: a resumed session
   * is disposed more than once, and the later row supersedes the earlier one
   * because it covers a longer log.
   *
   * @param row - The row to store.
   * @returns The stored row.
   * @throws TypeError When the session id cannot name a file safely.
   */
  async function putArchiveRow(row: ArchiveRow): Promise<ArchiveRow> {
    if (row.sessionId.length === 0 || row.sessionId.length > MAX_SESSION_ID_CHARS) {
      throw new TypeError(
        `dsh-context-ledger: session id must be a non-empty string of at most ${MAX_SESSION_ID_CHARS} characters`,
      )
    }
    await writeAtomically(archiveDir, archiveFileName(row.sessionId), serializeArchiveRow(row))
    return row
  }

  /**
   * List every well-formed archive row, newest first, plus why any file was skipped.
   *
   * @returns The archive listing.
   */
  async function listArchive(): Promise<ArchiveListing> {
    let names: string[]
    try {
      names = await readdir(archiveDir)
    } catch (error) {
      if (isMissing(error)) return { rows: [], skipped: [] }
      throw error
    }
    const files = names.filter(name => name.endsWith('.json')).sort()
    const results = await Promise.all(files.map(async (file): Promise<FileOutcome<ArchiveRow>> => {
      const read = await readTextFile(join(archiveDir, file))
      if (!read.ok) return { ok: false, file, reason: read.reason }
      const parsed = parseArchiveRow(read.text)
      return parsed.ok ? { ok: true, file, value: parsed.row } : { ok: false, file, reason: parsed.reason }
    }))
    const rows: ArchiveRow[] = []
    const skipped: SkippedFile[] = []
    for (const result of results) {
      if (result.ok) rows.push(result.value)
      else skipped.push({ file: result.file, reason: result.reason })
    }
    return { rows: orderRows(rows), skipped }
  }

  return { projectDir, memoryDir, archiveDir, list, get, put, search, putArchiveRow, listArchive }
}

/**
 * Produce a short, bounded excerpt of a body around the matched term.
 *
 * @param body - The entry body.
 * @param needle - The lowercased search term.
 * @param excerptChars - Maximum characters to return.
 * @returns The excerpt, ellipsized when it does not cover the whole body.
 */
function excerptOf(body: string, needle: string, excerptChars: number): string {
  const flat = body.replace(/\s+/gu, ' ').trim()
  if (flat.length <= excerptChars) return flat
  const at = flat.toLowerCase().indexOf(needle)
  const start = at <= 0 ? 0 : Math.max(0, at - Math.floor(excerptChars / 3))
  const slice = flat.slice(start, start + excerptChars)
  return `${start > 0 ? '…' : ''}${slice}${start + excerptChars < flat.length ? '…' : ''}`
}
