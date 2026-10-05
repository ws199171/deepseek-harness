import { describe, expect, it } from 'vitest'
import { resolveBudget } from '../src/budget.ts'
import {
  ENTRY_FORMAT_VERSION,
  ENTRY_KINDS,
  ENTRY_TIERS,
  censusOf,
  compareEntries,
  createEntry,
  entryId,
  indexCandidates,
  parseEntry,
  promoteEntry,
  rankForIndex,
  serializeEntry,
  tierRank,
  type Entry,
  type ParseEntryResult,
} from '../src/entry.ts'

const NOW = 1_700_000_000_000

/**
 * Build a valid create request, optionally overriding one field.
 *
 * @param overrides - Fields to replace.
 * @returns The request.
 */
function request(overrides: Record<string, unknown> = {}): Parameters<typeof createEntry>[0] {
  return { kind: 'build', title: 'Run tests with pnpm test', body: 'The repo uses pnpm.', now: NOW, ...overrides }
}

/**
 * Build a stored entry at a chosen tier, optionally overriding one field.
 *
 * @param overrides - Fields to replace.
 * @returns The entry.
 */
function entry(overrides: Partial<Entry> = {}): Entry {
  return { ...createEntry(request()), tier: 'confirmed', ...overrides }
}

/**
 * Unwrap a parse result, failing the test with the recorded reason.
 *
 * @param result - The parse outcome.
 * @returns The parsed entry.
 */
function parsedEntry(result: ParseEntryResult): Entry {
  if (!result.ok) throw new Error(`expected a parsed entry, received: ${result.reason}`)
  return result.entry
}

describe('entryId', () => {
  it('is stable for the same kind and title', () => {
    expect(entryId('build', 'Run tests')).toBe(entryId('build', 'Run tests'))
  })

  it('dedups cosmetic title differences', () => {
    expect(entryId('build', 'Run  tests')).toBe(entryId('build', '  run tests '))
  })

  it('distinguishes the kind and the title', () => {
    expect(entryId('build', 'Run tests')).not.toBe(entryId('pitfall', 'Run tests'))
    expect(entryId('build', 'Run tests')).not.toBe(entryId('build', 'Run lint'))
  })

  it('is filename-safe even for a title with no usable characters', () => {
    const id = entryId('note', '…')
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/u)
    expect(id.startsWith('entry-')).toBe(true)
  })
})

describe('createEntry', () => {
  it('starts unconfirmed and keeps the creation time of the entry it replaces', () => {
    const first = createEntry(request())
    expect(first.tier).toBe('auto')
    expect(first.createdAt).toBe(NOW)

    const second = createEntry(request({ now: NOW + 5000, existing: first }))
    expect(second.createdAt).toBe(NOW)
    expect(second.updatedAt).toBe(NOW + 5000)
  })

  it('rejects an unknown kind', () => {
    expect(() => createEntry(request({ kind: 'gossip' }))).toThrow(TypeError)
  })

  it('rejects an empty or oversized title', () => {
    expect(() => createEntry(request({ title: '   ' }))).toThrow(RangeError)
    expect(() => createEntry(request({ title: 'x'.repeat(201) }))).toThrow(RangeError)
  })
})

describe('serializeEntry and parseEntry', () => {
  it('round-trips every stored field', () => {
    const original = entry({ body: 'line one\nline two' })
    expect(parsedEntry(parseEntry(serializeEntry(original)))).toEqual(original)
  })

  it('carries the format version', () => {
    expect(serializeEntry(entry())).toContain(`"v":${ENTRY_FORMAT_VERSION}`)
  })

  it('survives a body containing frontmatter-like text', () => {
    expect(parsedEntry(parseEntry(serializeEntry(entry({ body: 'a\n---\nb' })))).body).toBe('a\n---\nb')
  })

  it('round-trips an empty body as empty', () => {
    expect(parsedEntry(parseEntry(serializeEntry(entry({ body: '' })))).body).toBe('')
  })

  it('reports a file that is not an entry instead of throwing', () => {
    const cases: Record<string, string> = {
      'plain text': 'just some notes\n',
      'unterminated frontmatter': '---\n{"v":1}\n',
      'unparseable header': '---\nnot json\n---\n\nbody\n',
      'header is not an object': '---\n42\n---\n\nbody\n',
      'a future format version': `---\n${JSON.stringify({ v: 99 })}\n---\n\nbody\n`,
      'an unknown kind': `---\n${JSON.stringify({ v: 1, id: 'x', kind: 'gossip', tier: 'auto', title: 't', createdAt: 1, updatedAt: 1 })}\n---\n\n`,
      'an unknown tier': `---\n${JSON.stringify({ v: 1, id: 'x', kind: 'note', tier: 'vibes', title: 't', createdAt: 1, updatedAt: 1 })}\n---\n\n`,
      'a missing timestamp': `---\n${JSON.stringify({ v: 1, id: 'x', kind: 'note', tier: 'auto', title: 't', createdAt: 1 })}\n---\n\n`,
    }
    for (const [label, text] of Object.entries(cases)) {
      const parsed = parseEntry(text)
      expect(parsed.ok, label).toBe(false)
      expect(parsed.ok ? '' : parsed.reason, label).toBeTypeOf('string')
    }
  })
})

describe('promoteEntry and tier ordering', () => {
  it('sets the tier, and refuses a tier it cannot promote to', () => {
    const promoted = promoteEntry(entry(), 'curated', NOW + 1)
    expect(promoted.tier).toBe('curated')
    expect(promoted.updatedAt).toBe(NOW + 1)
    expect(() => promoteEntry(entry(), 'auto', NOW)).toThrow(TypeError)
  })

  it('ranks curated above confirmed above auto', () => {
    expect([...ENTRY_TIERS].map(tierRank)).toEqual([0, 1, 2])
  })

  it('orders by trust first and recency second', () => {
    const ordered = [
      entry({ tier: 'confirmed', updatedAt: 1 }),
      entry({ tier: 'confirmed', updatedAt: 2 }),
      entry({ tier: 'curated', updatedAt: 0 }),
    ].sort(compareEntries)
    expect(ordered.map(item => item.updatedAt)).toEqual([0, 2, 1])
  })
})

describe('slot ranking', () => {
  it('lets only confirmed entries that fit the headline ceiling compete', () => {
    const budget = resolveBudget({ overrides: { maxIndexEntryBytes: 20, maxIndexEntries: 10 } })
    const candidates = indexCandidates([
      entry({ id: 'auto-one', tier: 'auto' }),
      entry({ id: 'short', tier: 'confirmed', title: 'Short fact' }),
      entry({ id: 'long', tier: 'confirmed', title: 'A headline that is far too long to inject' }),
      entry({ id: 'curated', tier: 'curated', title: 'Kept' }),
    ], budget)
    expect(candidates.map(item => item.id)).toEqual(['curated', 'short'])
  })

  it('honours the entry ceiling', () => {
    const budget = resolveBudget({ overrides: { maxIndexEntries: 1 } })
    const ranked = rankForIndex([
      entry({ id: 'a', tier: 'confirmed', updatedAt: 1 }),
      entry({ id: 'b', tier: 'confirmed', updatedAt: 2 }),
    ], budget)
    expect(ranked.map(item => item.id)).toEqual(['b'])
  })
})

describe('censusOf and the declared lists', () => {
  it('counts by kind and by tier and reports the total', () => {
    const census = censusOf([
      entry({ kind: 'build' }),
      entry({ kind: 'build', title: 'Other' }),
      entry({ kind: 'note', title: 'Third', tier: 'auto' }),
    ])
    expect(census.total).toBe(3)
    expect(census.byKind).toEqual({ build: 2, note: 1 })
    expect(census.byTier).toEqual({ confirmed: 2, auto: 1 })
  })

  it('keeps the kind list closed and ordered', () => {
    expect([...ENTRY_KINDS]).toEqual(['build', 'decision', 'pitfall', 'convention', 'note'])
  })
})
