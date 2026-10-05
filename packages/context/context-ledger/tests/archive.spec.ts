import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_FORMAT_VERSION,
  deriveArchiveRow,
  orderRows,
  parseArchiveRow,
  serializeArchiveRow,
  type ArchiveEvent,
  type ArchiveRow,
} from '../src/archive.ts'

const SESSION = 'session-abc'

/**
 * Build a synthetic session event.
 *
 * @param type - Event type.
 * @param seq - Sequence number.
 * @param time - Event timestamp.
 * @param data - Event payload.
 * @returns The event.
 */
function event(type: string, seq: number, time: number, data?: unknown): ArchiveEvent {
  return { type, seq, time, data }
}

/**
 * Fold events into a row, failing the test when there is nothing to archive.
 *
 * @param events - Events to fold.
 * @param maxPaths - Path ceiling.
 * @returns The derived row.
 */
function row(events: ArchiveEvent[], maxPaths = 20): ArchiveRow {
  const derived = deriveArchiveRow({ sessionId: SESSION, events, maxPaths })
  if (derived === undefined) throw new Error('expected a derived row')
  return derived
}

describe('deriveArchiveRow', () => {
  it('has nothing to archive for a session with no events', () => {
    expect(deriveArchiveRow({ sessionId: SESSION, events: [], maxPaths: 20 })).toBeUndefined()
  })

  it('records the span, the counts, and how the last turn ended', () => {
    const derived = row([
      event('turn/start', 0, 1_000, { turn: 1 }),
      event('step/start', 1, 1_010, { turn: 1, step: 1 }),
      event('tool/call', 2, 1_020, { name: 'read', arguments: '{"file_path":"a.ts"}' }),
      event('turn/end', 3, 1_500, { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', 4, 2_000, { turn: 2 }),
      event('step/start', 5, 2_010, { turn: 2, step: 1 }),
      event('compaction/start', 6, 2_100, { compactionId: 'c1' }),
      event('tool/call', 7, 2_200, { name: 'edit', arguments: '{"file_path":"b.ts"}' }),
      event('goal/change', 8, 2_300, { kind: 'goal/change' }),
      event('turn/end', 9, 3_000, { turn: 2, reason: { kind: 'aborted', reason: 'user' } }),
    ])

    expect(derived.v).toBe(ARCHIVE_FORMAT_VERSION)
    expect(derived.sessionId).toBe(SESSION)
    expect(derived.startedAt).toBe(1_000)
    expect(derived.endedAt).toBe(3_000)
    expect(derived.elapsedMs).toBe(2_000)
    expect(derived.turns).toBe(2)
    expect(derived.steps).toBe(2)
    expect(derived.toolCalls).toBe(2)
    expect(derived.compactions).toBe(1)
    expect(derived.goalChanges).toBe(1)
    expect(derived.lastTurnReason).toBe('aborted')
    expect([...derived.pathsTouched]).toEqual(['a.ts', 'b.ts'])
    expect(derived.pathsTouchedTotal).toBe(2)
  })

  it('leaves the last-turn reason unset for a session that never ended a turn', () => {
    const derived = row([event('turn/start', 0, 5, { turn: 1 })])
    expect('lastTurnReason' in derived).toBe(false)
    expect(derived.elapsedMs).toBe(0)
    expect(derived.turns).toBe(1)
  })

  it('ignores a turn/end without a usable reason kind', () => {
    expect('lastTurnReason' in row([event('turn/end', 0, 5, { turn: 1 })])).toBe(false)
    expect('lastTurnReason' in row([event('turn/end', 0, 5, { turn: 1, reason: { kind: 7 } })])).toBe(false)
  })

  it('deduplicates and sorts paths', () => {
    const derived = row([
      event('tool/call', 0, 10, { arguments: '{"file_path":"z.ts"}' }),
      event('tool/call', 1, 20, { arguments: '{"file_path":"a.ts"}' }),
      event('tool/call', 2, 30, { arguments: '{"file_path":"z.ts"}' }),
    ])
    expect([...derived.pathsTouched]).toEqual(['a.ts', 'z.ts'])
    expect(derived.pathsTouchedTotal).toBe(2)
  })

  it('keeps the most recently touched paths under a tight ceiling', () => {
    const derived = row([
      event('tool/call', 0, 10, { arguments: '{"file_path":"first.ts"}' }),
      event('tool/call', 1, 20, { arguments: '{"file_path":"second.ts"}' }),
      event('tool/call', 2, 30, { arguments: '{"file_path":"third.ts"}' }),
    ], 2)
    expect([...derived.pathsTouched]).toEqual(['second.ts', 'third.ts'])
    expect(derived.pathsTouchedTotal).toBe(3)
  })

  it('contributes no path for a tool call with unusable arguments', () => {
    const derived = row([
      event('tool/call', 0, 10, { arguments: 'not json' }),
      event('tool/call', 1, 20, { arguments: '{"other":"x"}' }),
      event('tool/call', 2, 30, { arguments: '{"file_path":"   "}' }),
      event('tool/call', 3, 40, { arguments: '{"file_path":42}' }),
      event('tool/call', 4, 50, undefined),
      event('tool/call', 5, 60, { arguments: '{"file_path":" ok.ts "}' }),
    ])
    expect([...derived.pathsTouched]).toEqual(['ok.ts'])
    expect(derived.pathsTouchedTotal).toBe(1)
  })

  it('never takes a path from a non-tool event', () => {
    expect(row([event('turn/start', 0, 10, { file_path: 'nope.ts' })]).pathsTouchedTotal).toBe(0)
  })
})

describe('serializeArchiveRow and parseArchiveRow', () => {
  it('round-trips a row', () => {
    const original = row([
      event('turn/start', 0, 1_000, { turn: 1 }),
      event('tool/call', 1, 1_100, { arguments: '{"file_path":"a.ts"}' }),
      event('compaction/start', 2, 1_200, { compactionId: 'c' }),
      event('turn/end', 3, 1_300, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const parsed = parseArchiveRow(serializeArchiveRow(original))
    expect(parsed.ok).toBe(true)
    expect(parsed.ok ? parsed.row : undefined).toEqual(original)
  })

  it('round-trips a row without a last-turn reason too', () => {
    const original = row([event('turn/start', 0, 10, { turn: 1 })])
    const parsed = parseArchiveRow(serializeArchiveRow(original))
    expect(parsed.ok).toBe(true)
    expect(parsed.ok ? parsed.row : undefined).toEqual(original)
  })

  it('reports a file that is not an archive row instead of throwing', () => {
    const good = JSON.parse(serializeArchiveRow(row([event('turn/start', 0, 1, { turn: 1 })]))) as Record<string, unknown>
    const cases: Record<string, string> = {
      'plain text': 'notes\n',
      'not an object': '42\n',
      'a future format version': JSON.stringify({ ...good, v: 99 }),
      'a missing session id': JSON.stringify({ ...good, sessionId: undefined }),
      'a non-numeric count': JSON.stringify({ ...good, turns: 'two' }),
      'paths that are not strings': JSON.stringify({ ...good, pathsTouched: [1, 2] }),
      'paths that are not a list': JSON.stringify({ ...good, pathsTouched: 'a.ts' }),
      'a non-string reason': JSON.stringify({ ...good, lastTurnReason: 7 }),
    }
    for (const [label, text] of Object.entries(cases)) {
      const parsed = parseArchiveRow(text)
      expect(parsed.ok, label).toBe(false)
      expect(parsed.ok ? '' : parsed.reason, label).toBeTypeOf('string')
    }
  })
})

describe('orderRows', () => {
  /**
   * Build a full row that differs only in the two fields ordering reads.
   *
   * @param sessionId - The session id.
   * @param endedAt - When the session ended.
   * @returns The row.
   */
  function ordered(sessionId: string, endedAt: number): ArchiveRow {
    return { ...row([event('turn/start', 0, 1, { turn: 1 })]), sessionId, endedAt }
  }

  it('orders newest first, with the session id breaking ties', () => {
    const rows = [ordered('a', 1), ordered('b', 2), ordered('c', 2)]
    expect(orderRows(rows).map(item => item.sessionId)).toEqual(['b', 'c', 'a'])
  })

  it('does not mutate the input', () => {
    const rows = [ordered('a', 1), ordered('b', 2)]
    orderRows(rows)
    expect(rows.map(item => item.sessionId)).toEqual(['a', 'b'])
  })
})

describe('unusable tool arguments', () => {
  it('contributes no path when the arguments JSON is not an object', () => {
    expect(row([event('tool/call', 0, 10, { arguments: '42' })]).pathsTouchedTotal).toBe(0)
    expect(row([event('tool/call', 1, 20, { arguments: '"a string"' })]).pathsTouchedTotal).toBe(0)
    expect(row([event('tool/call', 2, 30, { arguments: 'null' })]).pathsTouchedTotal).toBe(0)
  })

  it('breaks a same-millisecond tie by sequence, keeping the later call', () => {
    const derived = row([
      event('tool/call', 0, 10, { arguments: '{"file_path":"first.ts"}' }),
      event('tool/call', 5, 10, { arguments: '{"file_path":"last.ts"}' }),
    ], 1)
    expect([...derived.pathsTouched]).toEqual(['last.ts'])
    expect(derived.pathsTouchedTotal).toBe(2)
  })
})
