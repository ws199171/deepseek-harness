import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ArchiveRow } from '../src/archive.ts'
import { createEntry, serializeEntry, type Entry } from '../src/entry.ts'
import { LEDGER_DIR, archiveFileName, createStore, projectKey, type LedgerStore, type StoreGetResult } from '../src/store.ts'

const NOW = 1_700_000_000_000
const PROJECT = '/work/demo'

let home = ''

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'context-ledger-store-'))
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

/**
 * Open a store in a fresh sub-home so cases do not share entries.
 *
 * @returns The store and the home it was placed in.
 */
async function freshStore(): Promise<{ store: LedgerStore; scoped: string }> {
  const scoped = await mkdtemp(join(home, 'case-'))
  return { store: createStore({ home: scoped, projectRoot: PROJECT }), scoped }
}

/**
 * Build an entry, optionally overriding one field.
 *
 * @param title - The entry title.
 * @param overrides - Fields to replace.
 * @returns The entry.
 */
function entry(title: string, overrides: Partial<Entry> = {}): Entry {
  return { ...createEntry({ kind: 'note', title, body: 'body', now: NOW }), ...overrides }
}

/**
 * Build an archive row for one session.
 *
 * @param sessionId - The session id.
 * @param endedAt - When the session ended.
 * @returns The row.
 */
function archiveRow(sessionId: string, endedAt: number): ArchiveRow {
  return {
    v: 1,
    sessionId,
    startedAt: endedAt - 1_000,
    endedAt,
    elapsedMs: 1_000,
    turns: 3,
    steps: 4,
    toolCalls: 5,
    compactions: 0,
    goalChanges: 0,
    lastTurnReason: 'completed',
    pathsTouched: ['a.ts'],
    pathsTouchedTotal: 1,
  }
}

/**
 * Unwrap a store read, failing the test with the recorded reason.
 *
 * @param result - The read outcome.
 * @returns The entry.
 */
function readEntry(result: StoreGetResult): Entry {
  if (!result.ok) throw new Error(`expected an entry, received: ${result.reason}`)
  return result.entry
}

describe('projectKey', () => {
  it('is deterministic, readable, and root-specific', () => {
    const key = projectKey(PROJECT)
    expect(key).toBe(projectKey(PROJECT))
    expect(key).not.toBe(projectKey('/work/other'))
    expect(key).toBe(`demo-${key.split('-').at(-1) ?? ''}`)
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/u)
  })

  it('keeps two projects sharing a directory name apart', () => {
    expect(projectKey('/one/demo')).not.toBe(projectKey('/two/demo'))
  })
})

describe('store placement', () => {
  it('places the store under the Harness home', async () => {
    const { store } = await freshStore()
    expect(store.memoryDir.startsWith(join(home, 'case-'))).toBe(true)
    expect(store.projectDir).toContain(LEDGER_DIR)
    expect(store.memoryDir.endsWith(join('memory'))).toBe(true)
  })

  it('lists nothing rather than failing for an unwritten store', async () => {
    const { store } = await freshStore()
    expect(await store.list()).toEqual({ entries: [], skipped: [] })
  })
})

describe('put and get', () => {
  it('reads a stored entry back byte-identical', async () => {
    const { store } = await freshStore()
    const original = entry('Round trip', { body: 'multi\nline' })
    await store.put(original)
    expect(readEntry(await store.get(original.id))).toEqual(original)
  })

  it('leaves no temporary file behind', async () => {
    const { store } = await freshStore()
    const original = entry('Atomic')
    await store.put(original)
    expect(await readdir(store.memoryDir)).toEqual([`${original.id}.md`])
  })

  it('replaces an entry in place on a rewrite rather than adding one', async () => {
    const { store } = await freshStore()
    const first = entry('Same fact')
    await store.put(first)
    await store.put({ ...first, body: 'corrected', updatedAt: NOW + 1 })
    const { entries } = await store.list()
    expect(entries).toHaveLength(1)
    expect(entries.map(item => item.body)).toEqual(['corrected'])
  })

  it('writes human-readable markdown with a JSON header', async () => {
    const { store } = await freshStore()
    const original = entry('Readable on disk')
    await store.put(original)
    const text = await readFile(join(store.memoryDir, `${original.id}.md`), 'utf8')
    expect(text).toBe(serializeEntry(original))
    expect(text.startsWith('---\n{"v":1')).toBe(true)
    expect(text).toContain('\n---\n\nbody\n')
  })
})

describe('listing and reading failures', () => {
  it('reports malformed files with a reason instead of hiding them', async () => {
    const { store } = await freshStore()
    await store.put(entry('Good'))
    await store.put(entry('Also good'))
    await writeFile(join(store.memoryDir, 'notes.md'), 'not a ledger entry\n')
    await writeFile(join(store.memoryDir, 'ignored.txt'), 'not markdown\n')

    const { entries, skipped } = await store.list()

    expect(entries).toHaveLength(2)
    expect(skipped.map(item => item.file)).toEqual(['notes.md'])
    expect(skipped.map(item => item.reason).join()).toMatch(/frontmatter/u)
  })

  it('skips an unreadable entry file without failing the listing', async () => {
    const { store } = await freshStore()
    await store.put(entry('Readable'))
    await writeFile(join(store.memoryDir, 'unreadable.md'), '---\n{"v":1}\n---\n\n')
    const { entries, skipped } = await store.list()
    expect(entries).toHaveLength(1)
    expect(skipped.map(item => item.reason).join()).toMatch(/missing id or title|version/u)
  })

  it('distinguishes a malformed entry from an absent one', async () => {
    const { store } = await freshStore()
    await mkdir(store.memoryDir, { recursive: true })
    await writeFile(join(store.memoryDir, 'broken.md'), 'nope\n')
    const missing = await store.get('does-not-exist')
    expect(missing.ok).toBe(false)
    expect(missing.ok ? '' : missing.reason).toMatch(/no entry/u)
  })

  it('refuses an id that would escape the memory directory', async () => {
    const { store } = await freshStore()
    for (const id of ['../escape', 'a/b', '..', '', 'UPPER', '.hidden']) {
      const result = await store.get(id)
      expect(result.ok, id).toBe(false)
      expect(result.ok ? '' : result.reason, id).toMatch(/invalid entry id|no entry/u)
    }
  })
})

describe('search', () => {
  it('matches titles and bodies case-insensitively', async () => {
    const { store } = await freshStore()
    await store.put(entry('Run tests', { body: 'pnpm test' }))
    await store.put(entry('Lint', { body: 'run pnpm lint' }))
    await store.put(entry('Unrelated', { body: 'nothing here' }))

    const byTitle = await store.search('tests', 10, 240)
    expect(byTitle.matches.map(match => match.title)).toEqual(['Run tests'])
    expect(byTitle.total).toBe(1)

    expect((await store.search('PNPM', 10, 240)).total).toBe(2)
  })

  it('matches nothing for an empty query rather than everything', async () => {
    const { store } = await freshStore()
    await store.put(entry('Something'))
    const result = await store.search('   ', 10, 240)
    expect(result.matches).toEqual([])
    expect(result.total).toBe(0)
  })

  it('caps its matches and reports the true total', async () => {
    const { store } = await freshStore()
    for (const title of ['Alpha one', 'Alpha two', 'Alpha three']) await store.put(entry(title))
    const result = await store.search('alpha', 2, 240)
    expect(result.matches).toHaveLength(2)
    expect(result.total).toBe(3)
  })

  it('ranks confirmed facts above unconfirmed ones', async () => {
    const { store } = await freshStore()
    await store.put(entry('Plain fact'))
    await store.put(entry('Trusted fact', { tier: 'confirmed', updatedAt: NOW + 10 }))
    const result = await store.search('fact', 5, 240)
    expect(result.matches.map(match => match.title)).toEqual(['Trusted fact', 'Plain fact'])
  })

  it('excerpts a long body around the match, bounded and ellipsized', async () => {
    const { store } = await freshStore()
    await store.put(entry('Long', { body: `${'x'.repeat(400)} needle ${'y'.repeat(400)}` }))
    const result = await store.search('needle', 5, 60)
    const excerpt = result.matches.map(match => match.excerpt).join('')
    expect(excerpt).toContain('needle')
    expect(excerpt.length).toBeLessThanOrEqual(62)
    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('excerpts a short body without ellipsis', async () => {
    const { store } = await freshStore()
    await store.put(entry('Short', { body: 'a short body' }))
    const result = await store.search('short', 5, 240)
    expect(result.matches.map(match => match.excerpt)).toEqual(['a short body'])
  })
})

describe('archiveFileName', () => {
  it('is readable, sanitized, and collision-resistant', () => {
    expect(archiveFileName('session-a')).toMatch(/^session-a-[0-9a-f]{8}\.json$/u)
    // A separator cannot survive sanitization, so it cannot escape the directory.
    expect(archiveFileName('../../etc/passwd')).not.toContain('/')
    expect(archiveFileName('a b')).not.toContain(' ')
    // Two ids that sanitize to the same text keep distinct file names.
    expect(archiveFileName('a/b')).not.toBe(archiveFileName('a_b'))
    expect(archiveFileName('')).toBe(`session-${archiveFileName('').split('-').at(-1) ?? ''}`)
  })
})

describe('the archive', () => {
  it('lists nothing rather than failing when unwritten', async () => {
    const { store } = await freshStore()
    expect(await store.listArchive()).toEqual({ rows: [], skipped: [] })
  })

  it('reads an archived session back byte-identical', async () => {
    const { store } = await freshStore()
    const original = archiveRow('session-a', 1_700_000_000_000)
    await store.putArchiveRow(original)
    const { rows } = await store.listArchive()
    expect(rows).toEqual([original])
  })

  it('lists newest first', async () => {
    const { store } = await freshStore()
    await store.putArchiveRow(archiveRow('session-old', 1_000))
    await store.putArchiveRow(archiveRow('session-new', 2_000))
    const { rows } = await store.listArchive()
    expect(rows.map(row => row.sessionId)).toEqual(['session-new', 'session-old'])
  })

  it('replaces a re-archived session rather than adding a row', async () => {
    const { store } = await freshStore()
    await store.putArchiveRow(archiveRow('session-a', 1_000))
    await store.putArchiveRow(archiveRow('session-a', 2_000))
    const { rows } = await store.listArchive()
    expect(rows.map(row => row.endedAt)).toEqual([2_000])
  })

  it('reports and skips a malformed archive file', async () => {
    const { store } = await freshStore()
    await store.putArchiveRow(archiveRow('session-a', 1_000))
    await writeFile(join(store.archiveDir, 'notes.json'), 'not a row\n')
    await writeFile(join(store.archiveDir, 'ignored.txt'), 'not json at all\n')
    const { rows, skipped } = await store.listArchive()
    expect(rows).toHaveLength(1)
    expect(skipped.map(item => item.file)).toEqual(['notes.json'])
  })

  it('refuses an archive row with an unusable session id', async () => {
    const { store } = await freshStore()
    await expect(store.putArchiveRow(archiveRow('', 1))).rejects.toThrow(TypeError)
    await expect(store.putArchiveRow(archiveRow('x'.repeat(600), 1))).rejects.toThrow(TypeError)
  })

  it('keeps the archive and the memory directory from seeing each other', async () => {
    const { store } = await freshStore()
    await store.put(entry('A fact'))
    await store.putArchiveRow(archiveRow('session-a', 1))
    expect((await store.list()).entries).toHaveLength(1)
    expect((await store.listArchive()).rows).toHaveLength(1)
    expect(store.archiveDir).toBe(join(store.projectDir, 'archive'))
    expect(store.archiveDir).not.toBe(store.memoryDir)
  })
})

describe('filesystem failures the store must not absorb', () => {
  it('cleans up the temporary file when the rename fails, and rethrows', async () => {
    const { store } = await freshStore()
    const target = entry('Blocked')
    // A non-empty directory at the target path makes rename fail.
    const blocker = join(store.memoryDir, `${target.id}.md`)
    await mkdir(blocker, { recursive: true })
    await writeFile(join(blocker, 'occupied'), 'x')

    await expect(store.put(target)).rejects.toThrow()

    const leftovers = (await readdir(store.memoryDir)).filter(name => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('reports an unreadable memory directory instead of reading it as empty', async () => {
    const { store } = await freshStore()
    // A file where the directory should be makes readdir fail with a code that is
    // not ENOENT, which must propagate rather than read as "no entries".
    await mkdir(store.projectDir, { recursive: true })
    await writeFile(store.memoryDir, 'not a directory\n')

    await expect(store.list()).rejects.toThrow()
  })

  it('reports an unreadable archive directory instead of reading it as empty', async () => {
    const { store } = await freshStore()
    await mkdir(store.projectDir, { recursive: true })
    await writeFile(store.archiveDir, 'not a directory\n')

    await expect(store.listArchive()).rejects.toThrow()
  })
})

describe('files that cannot be read', () => {
  it('skips a memory file that readFile refuses, rather than failing the listing', async () => {
    const { store } = await freshStore()
    // A directory where an entry file is expected makes readFile fail.
    await mkdir(join(store.memoryDir, 'unreadable.md'), { recursive: true })

    const { entries, skipped } = await store.list()

    expect(entries).toEqual([])
    expect(skipped.map(item => item.file)).toEqual(['unreadable.md'])
  })

  it('skips an archive file that readFile refuses', async () => {
    const { store } = await freshStore()
    await mkdir(join(store.archiveDir, 'unreadable.json'), { recursive: true })

    const { rows, skipped } = await store.listArchive()

    expect(rows).toEqual([])
    expect(skipped.map(item => item.file)).toEqual(['unreadable.json'])
  })
})

describe('keys and excerpts at their edges', () => {
  it('falls back to a placeholder name for a root with no usable directory name', () => {
    expect(projectKey('/')).toMatch(/^project-[0-9a-f]{12}$/u)
    expect(projectKey('/')).not.toBe(projectKey('/other'))
  })

  it('excerpts from the beginning when the match is at the start', async () => {
    const { store } = await freshStore()
    await store.put(entry('Start', { body: `needle ${'y'.repeat(400)}` }))
    const result = await store.search('needle', 5, 60)
    const excerpt = result.matches.map(match => match.excerpt).join('')
    expect(excerpt).toContain('needle')
    // No leading ellipsis: nothing was cut from the front.
    expect(excerpt.startsWith('needle')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('excerpts to the end when the match is at the tail', async () => {
    const { store } = await freshStore()
    await store.put(entry('Tail', { body: `${'x'.repeat(400)} needle` }))
    const result = await store.search('needle', 5, 60)
    const excerpt = result.matches.map(match => match.excerpt).join('')
    expect(excerpt.startsWith('…')).toBe(true)
    // No trailing ellipsis: the window reaches the end of the body.
    expect(excerpt.endsWith('needle')).toBe(true)
  })
})

describe('reading one malformed entry by id', () => {
  it('reports the parse reason for an id whose file is damaged', async () => {
    const { store } = await freshStore()
    await mkdir(store.memoryDir, { recursive: true })
    await writeFile(join(store.memoryDir, 'broken.md'), 'not an entry\n')

    const result = await store.get('broken')

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toMatch(/^entry broken: /u)
  })
})
