/**
 * The memory entry model: one durable fact about a project.
 *
 * Entries are stored as markdown with a JSON frontmatter header. JSON rather
 * than YAML because the header must round-trip exactly and parsing it needs no
 * dependency; markdown because the body is prose a person may edit by hand.
 *
 * Every function here is pure and takes its clock as an argument, so tests are
 * deterministic and the store owns all filesystem effects.
 *
 * @module dsh-context-ledger/entry
 */

import { errorMessage } from './errors.ts'

import { createHash } from 'node:crypto'
import type { BudgetSpec } from './budget.ts'

/** Version of the stored entry format. A future shape is a new number, not a redefinition. */
export const ENTRY_FORMAT_VERSION = 1

/** The kinds a project fact may be filed under. Closed so the catalog line stays meaningful. */
export type EntryKind = 'build' | 'decision' | 'pitfall' | 'convention' | 'note'

/**
 * The trust tiers, weakest first.
 *
 * A model proposal is always `auto`. Only a recorded human approval promotes an
 * entry, and only `confirmed` and `curated` entries earn an always-injected slot.
 */
export type EntryTier = 'auto' | 'confirmed' | 'curated'

/** The tiers a promotion may target. */
export type PromotableTier = 'confirmed' | 'curated'

/** The kinds a project fact may be filed under, as a list. */
export const ENTRY_KINDS: readonly EntryKind[] = Object.freeze(['build', 'decision', 'pitfall', 'convention', 'note'])

/** The trust tiers, weakest first, as a list. */
export const ENTRY_TIERS: readonly EntryTier[] = Object.freeze(['auto', 'confirmed', 'curated'])

/** The tiers a promotion may target, as a list. */
export const PROMOTABLE_TIERS: readonly PromotableTier[] = Object.freeze(['confirmed', 'curated'])

/** Longest accepted title, in characters. */
export const MAX_TITLE_CHARS = 200

/** One durable fact about a project. */
export interface Entry {
  /** Filename-safe identity derived from kind and normalized title. */
  readonly id: string
  /** Which fact class this is. */
  readonly kind: EntryKind
  /** How much trust it has earned. */
  readonly tier: EntryTier
  /** The one-line headline, and the whole of what an injected slot carries. */
  readonly title: string
  /** The prose body, retrieved on demand rather than injected. */
  readonly body: string
  /** Epoch milliseconds of first creation. */
  readonly createdAt: number
  /** Epoch milliseconds of the last write. */
  readonly updatedAt: number
}

/** What was recorded per kind and per tier. */
export interface EntryCensus {
  /** Counts keyed by entry kind. */
  readonly byKind: Record<string, number>
  /** Counts keyed by trust tier. */
  readonly byTier: Record<string, number>
  /** Total stored entries. */
  readonly total: number
}

/** The outcome of parsing a stored file. */
export type ParseEntryResult = { readonly ok: true; readonly entry: Entry } | { readonly ok: false; readonly reason: string }

const OPEN = '---\n'
const CLOSE = '\n---\n'
const KIND_SET: ReadonlySet<string> = new Set<string>(ENTRY_KINDS)
const TIER_SET: ReadonlySet<string> = new Set<string>(ENTRY_TIERS)

/**
 * Normalize a title so cosmetic differences dedup to one entry.
 *
 * @param title - The raw title.
 * @returns Lowercased, whitespace-collapsed, trimmed.
 */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/gu, ' ').toLowerCase()
}

/**
 * Derive an entry's stable id from its kind and normalized title.
 *
 * Re-writing the same fact updates the existing entry instead of accumulating
 * near-duplicates, which is what keeps a repeatedly-used project from filling its
 * index with the same knowledge restated.
 *
 * @param kind - The entry kind.
 * @param title - The raw title.
 * @returns A filename-safe id.
 */
export function entryId(kind: string, title: string): string {
  const slug = normalizeTitle(title)
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  const hash = createHash('sha256').update(`${kind}\u0000${slug}`, 'utf8').digest('hex').slice(0, 8)
  return `${slug.length > 0 ? slug : 'entry'}-${hash}`
}

/**
 * Build a validated entry at the `auto` tier, preserving the creation time of the entry it replaces.
 *
 * @param request - The create request.
 * @param request.kind - One of {@link ENTRY_KINDS}.
 * @param request.title - Non-empty, at most {@link MAX_TITLE_CHARS} characters.
 * @param request.body - Entry prose, possibly empty.
 * @param request.now - Epoch milliseconds.
 * @param request.existing - The entry being replaced, when updating.
 * @returns The frozen entry.
 * @throws TypeError When the kind is unknown.
 * @throws RangeError When the title is empty or too long.
 */
export function createEntry(request: {
  kind: string
  title: string
  body: string
  now: number
  existing?: { readonly createdAt: number } | undefined
}): Entry {
  const { kind, title, body, now, existing } = request
  if (!KIND_SET.has(kind)) {
    throw new TypeError(
      `dsh-context-ledger: unknown entry kind ${JSON.stringify(kind)}; expected one of ${ENTRY_KINDS.join(', ')}`,
    )
  }
  const trimmedTitle = title.trim()
  if (trimmedTitle.length === 0) throw new RangeError('dsh-context-ledger: an entry needs a non-empty title')
  if (trimmedTitle.length > MAX_TITLE_CHARS) {
    throw new RangeError(
      `dsh-context-ledger: entry title is ${trimmedTitle.length} characters, over the ${MAX_TITLE_CHARS} limit`,
    )
  }
  return Object.freeze({
    id: entryId(kind, trimmedTitle),
    kind: kind as EntryKind,
    tier: 'auto',
    title: trimmedTitle,
    body,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
}

/**
 * Serialize an entry to its stored form.
 *
 * @param entry - The entry.
 * @returns Versioned frontmatter, a blank line, the body, and a trailing newline.
 */
export function serializeEntry(entry: Entry): string {
  const header = JSON.stringify({
    v: ENTRY_FORMAT_VERSION,
    id: entry.id,
    kind: entry.kind,
    tier: entry.tier,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  })
  return `${OPEN}${header}${CLOSE}\n${entry.body}\n`
}

/**
 * Parse a stored entry.
 *
 * A file that is not a well-formed entry is reported rather than thrown: the
 * memory directory is one a person may edit, so an unreadable file must not break
 * the plugin. The store records the reason and skips the file.
 *
 * @param text - The file contents.
 * @returns The parsed entry, or the reason it was not one.
 */
export function parseEntry(text: string): ParseEntryResult {
  if (!text.startsWith(OPEN)) return { ok: false, reason: 'missing frontmatter' }
  const closeIndex = text.indexOf(CLOSE, OPEN.length)
  if (closeIndex === -1) return { ok: false, reason: 'unterminated frontmatter' }
  let header: unknown
  try {
    header = JSON.parse(text.slice(OPEN.length, closeIndex))
  } catch (error) {
    // The header failed JSON parsing, so this file was not written by this plugin.
    const reason = errorMessage(error)
    return { ok: false, reason: `unparseable header: ${reason}` }
  }
  if (typeof header !== 'object' || header === null) return { ok: false, reason: 'header is not an object' }
  const record = header as Record<string, unknown>
  if (record.v !== ENTRY_FORMAT_VERSION) {
    return { ok: false, reason: `entry format version ${JSON.stringify(record.v)} is not ${ENTRY_FORMAT_VERSION}` }
  }
  const { id, kind, tier, title, createdAt, updatedAt } = record
  if (typeof id !== 'string' || typeof title !== 'string') return { ok: false, reason: 'header is missing id or title' }
  if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
    return { ok: false, reason: `unknown kind ${JSON.stringify(kind)}` }
  }
  if (typeof tier !== 'string' || !TIER_SET.has(tier)) {
    return { ok: false, reason: `unknown tier ${JSON.stringify(tier)}` }
  }
  for (const [fieldName, value] of Object.entries({ createdAt, updatedAt })) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: `${fieldName} is not a number` }
  }
  return {
    ok: true,
    entry: Object.freeze({
      id,
      kind: kind as EntryKind,
      tier: tier as EntryTier,
      title,
      body: text.slice(closeIndex + CLOSE.length + 1).replace(/\n$/u, ''),
      createdAt: createdAt as number,
      updatedAt: updatedAt as number,
    }),
  }
}

/**
 * Return a copy of the entry at a new tier, exempting it from size-based exclusion.
 *
 * @param entry - The entry to promote.
 * @param tier - The tier to promote to.
 * @param now - Epoch milliseconds.
 * @returns The promoted entry.
 * @throws TypeError When the tier is not a promotable tier.
 */
export function promoteEntry(entry: Entry, tier: string, now: number): Entry {
  if (tier !== 'confirmed' && tier !== 'curated') {
    throw new TypeError(`dsh-context-ledger: cannot promote to ${JSON.stringify(tier)}`)
  }
  return Object.freeze({ ...entry, tier, updatedAt: now })
}

/**
 * Rank an entry's trust tier for display ordering.
 *
 * @param tier - The entry tier.
 * @returns `curated` above `confirmed` above `auto`.
 */
export function tierRank(tier: string): number {
  return tier === 'curated' ? 2 : tier === 'confirmed' ? 1 : 0
}

/**
 * Order entries for display: trust first, then most recently updated.
 *
 * Recency of update rather than of use, so ordering needs no usage bookkeeping
 * and a read never has to write.
 *
 * @param left - One entry.
 * @param right - The other entry.
 * @returns A comparator result.
 */
export function compareEntries(left: Entry, right: Entry): number {
  return tierRank(right.tier) - tierRank(left.tier) || right.updatedAt - left.updatedAt
}

/**
 * Rank every entry that could occupy an index slot, best first and unsliced.
 *
 * Only `confirmed` and `curated` entries compete, and only on their headline: a
 * long entry is fetch-only by construction rather than by eviction, so one
 * verbose fact cannot push others out of the injected payload.
 *
 * @param entries - Every stored entry.
 * @param budget - The resolved ceilings.
 * @returns Every eligible entry in ranking order.
 */
export function indexCandidates(entries: readonly Entry[], budget: BudgetSpec): Entry[] {
  return entries
    .filter(entry => tierRank(entry.tier) > 0)
    .filter(entry => Buffer.byteLength(entry.title, 'utf8') <= budget.maxIndexEntryBytes)
    .sort(compareEntries)
}

/**
 * The entries that actually get an injected slot.
 *
 * @param entries - Every stored entry.
 * @param budget - The resolved ceilings.
 * @returns At most `budget.maxIndexEntries` entries, best first.
 */
export function rankForIndex(entries: readonly Entry[], budget: BudgetSpec): Entry[] {
  return indexCandidates(entries, budget).slice(0, budget.maxIndexEntries)
}

/**
 * Count stored entries per kind and per tier, for the catalog line.
 *
 * @param entries - Every stored entry.
 * @returns The census.
 */
export function censusOf(entries: readonly Entry[]): EntryCensus {
  const byKind: Record<string, number> = {}
  const byTier: Record<string, number> = {}
  for (const entry of entries) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
    byTier[entry.tier] = (byTier[entry.tier] ?? 0) + 1
  }
  return { byKind, byTier, total: entries.length }
}
