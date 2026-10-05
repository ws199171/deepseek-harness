import { describe, expect, it } from 'vitest'
import type { ArchiveRow } from '../src/archive.ts'
import { resolveBudget } from '../src/budget.ts'
import { renderBrief } from '../src/brief.ts'
import type { Entry, EntryKind } from '../src/entry.ts'

const ROOT = '/work/demo'

/**
 * Build a budget with a wide brief ceiling, optionally overriding one value.
 *
 * @param overrides - Ceiling overrides.
 * @returns The budget.
 */
function budget(overrides: Record<string, number> = {}) {
  return resolveBudget({ overrides: { maxBriefBytes: 65536, ...overrides } })
}

/**
 * Build an archive row, optionally overriding one field.
 *
 * @param overrides - Fields to replace.
 * @returns The row.
 */
function row(overrides: Partial<ArchiveRow> = {}): ArchiveRow {
  return {
    v: 1,
    sessionId: 'session-a',
    startedAt: 0,
    endedAt: 1_700_000_000_000,
    elapsedMs: 1_000,
    turns: 4,
    steps: 6,
    toolCalls: 9,
    compactions: 1,
    goalChanges: 0,
    lastTurnReason: 'completed',
    pathsTouched: ['a.ts', 'b.ts'],
    pathsTouchedTotal: 2,
    ...overrides,
  }
}

/**
 * Build a confirmed fact that earns a headline.
 *
 * @param title - The fact's headline.
 * @param kind - The fact's kind.
 * @returns The entry.
 */
function fact(title: string, kind: EntryKind = 'decision'): Entry {
  return { id: title.toLowerCase(), kind, tier: 'confirmed', title, body: '', createdAt: 0, updatedAt: 0 }
}

const HEADER = 'Handoff brief for project'
const ROWS = 'Recent sessions, most recent first:'
const FACTS = 'Facts every session of this project already receives:'
const FOOTER = 'Start a new session in this project'

/**
 * Byte length of a string as UTF-8, which is what the ceiling counts.
 *
 * @param text - The text to measure.
 * @returns Its byte length.
 */
function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

describe('renderBrief', () => {
  it('says what it is and what to do with it', () => {
    const text = renderBrief({ projectRoot: ROOT, rows: [], facts: [], budget: budget() })
    expect(text).toContain(HEADER)
    expect(text).toContain(FOOTER)
    expect(text).not.toContain(ROWS)
    expect(text).not.toContain(FACTS)
  })

  it('carries rows, the facts, and the closing instruction', () => {
    const text = renderBrief({
      projectRoot: ROOT,
      rows: [row()],
      facts: [fact('Use pnpm, not npm')],
      budget: budget(),
    })
    expect(text).toContain(ROWS)
    expect(text).toContain('4 turns')
    expect(text).toContain('9 tool calls')
    expect(text).toContain('1 compaction')
    expect(text).toContain('last turn completed')
    expect(text).toContain('2 paths')
    expect(text).toContain('a.ts, b.ts')
    expect(text).toContain(FACTS)
    expect(text).toContain('- [decision] Use pnpm, not npm')
  })

  it('reports compactions only when there were any', () => {
    const without = renderBrief({ projectRoot: ROOT, rows: [row({ compactions: 0 })], facts: [], budget: budget() })
    expect(without).not.toContain('compaction')
  })

  it('reports a truncated path list as a fraction', () => {
    const text = renderBrief({
      projectRoot: ROOT,
      rows: [row({ pathsTouched: ['a.ts'], pathsTouchedTotal: 9 })],
      facts: [],
      budget: budget(),
    })
    expect(text).toContain('1 of 9 paths')
  })

  it('omits the path clause for a session that touched nothing', () => {
    const text = renderBrief({
      projectRoot: ROOT,
      rows: [row({ pathsTouched: [], pathsTouchedTotal: 0 })],
      facts: [],
      budget: budget(),
    })
    expect(text).not.toContain('path')
  })

  it('sheds content in the documented order as the ceiling tightens', () => {
    const input = {
      projectRoot: ROOT,
      rows: [row(), row({ sessionId: 'session-b', endedAt: 1_600_000_000_000 })],
      facts: [fact('Use pnpm, not npm')],
    }

    const full = renderBrief({ ...input, budget: budget() })
    expect([ROWS, FACTS, 'a.ts', 'session-b'].map(marker => full.includes(marker))).toEqual([true, true, true, true])

    // One byte short of full: the facts go first, because a new session in this
    // project receives them automatically.
    const noFacts = renderBrief({ ...input, budget: budget({ maxBriefBytes: bytesOf(full) - 1 }) })
    expect(noFacts).not.toContain(FACTS)
    expect(noFacts).toContain(ROWS)
    expect(noFacts).toContain('a.ts')

    // Next: the path lists go, while both rows stay.
    const noPaths = renderBrief({ ...input, budget: budget({ maxBriefBytes: bytesOf(noFacts) - 1 }) })
    expect(noPaths).not.toContain('a.ts')
    expect(noPaths).toContain(ROWS)
    expect(noPaths).toContain('session-b')

    // Next: every row but the most recent goes.
    const newestOnly = renderBrief({ ...input, budget: budget({ maxBriefBytes: bytesOf(noPaths) - 1 }) })
    expect(newestOnly).toContain(ROWS)
    expect(newestOnly).not.toContain('session-b')

    // Next: the row section goes entirely, leaving the header and the instruction.
    const bare = renderBrief({ ...input, budget: budget({ maxBriefBytes: bytesOf(newestOnly) - 1 }) })
    expect(bare).not.toContain(ROWS)
    expect(bare).toContain(HEADER)
    expect(bare).toContain(FOOTER)
  })

  it('contributes nothing when the ceiling cannot hold the header alone', () => {
    const bare = renderBrief({ projectRoot: ROOT, rows: [row()], facts: [], budget: budget() })
    expect(renderBrief({
      projectRoot: ROOT,
      rows: [row()],
      facts: [],
      budget: budget({ maxBriefBytes: 8 }),
    })).toBe('')
    expect(bare.length).toBeGreaterThan(0)
  })

  it('is deterministic for identical inputs', () => {
    const input = { projectRoot: ROOT, rows: [row()], facts: [fact('One')], budget: budget() }
    expect(renderBrief(input)).toBe(renderBrief(input))
  })

  it('never truncates a value mid-way', () => {
    const longPath = 'a'.repeat(400)
    const text = renderBrief({
      projectRoot: ROOT,
      rows: [row({ pathsTouched: [longPath], pathsTouchedTotal: 1 })],
      facts: [],
      budget: budget(),
    })
    expect(text).toContain(longPath)
  })
})

describe('unit pluralisation', () => {
  it('uses singular units for a session with one of each', () => {
    const text = renderBrief({
      projectRoot: ROOT,
      rows: [row({ turns: 1, toolCalls: 1, compactions: 1, pathsTouched: ['a.ts'], pathsTouchedTotal: 1 })],
      facts: [],
      budget: budget(),
    })
    expect(text).toContain('1 turn ·')
    expect(text).toContain('1 tool call ·')
    expect(text).toContain('1 compaction ·')
    expect(text).toContain('1 path')
  })

  it('omits the path clause entirely when the row touched nothing', () => {
    const text = renderBrief({
      projectRoot: ROOT,
      rows: [row({ pathsTouched: [], pathsTouchedTotal: 0, compactions: 0 })],
      facts: [],
      budget: budget(),
    })
    expect(text).not.toContain('paths')
    expect(text).not.toContain('path ·')
  })
})

describe('optional clauses', () => {
  it('pluralises compactions and omits the last-turn clause when there is none', () => {
    const text = renderBrief({
      projectRoot: ROOT,
      rows: [row({ compactions: 2, lastTurnReason: undefined })],
      facts: [],
      budget: budget(),
    })
    expect(text).toContain('2 compactions')
    expect(text).not.toContain('last turn')
  })

  it('omits the compaction clause when there were none', () => {
    const text = renderBrief({
      projectRoot: ROOT,
      rows: [row({ compactions: 0 })],
      facts: [],
      budget: budget(),
    })
    expect(text).not.toContain('compaction')
  })
})
