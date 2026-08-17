import { describe, expect, it } from 'vitest'
import { parseCliLine } from '../src/wire.ts'

describe('parseCliLine', () => {
  it('returns undefined for blank lines', () => {
    expect(parseCliLine('', '')).toBeUndefined()
    expect(parseCliLine('   ', '')).toBeUndefined()
  })

  it('ignores non-JSON lines', () => {
    expect(parseCliLine('not json at all', '')).toEqual({ kind: 'ignored' })
  })

  it('ignores unrelated event types', () => {
    expect(parseCliLine(JSON.stringify({ type: 'system', subtype: 'init' }), '')).toEqual({ kind: 'ignored' })
  })

  it('computes cumulative assistant text deltas', () => {
    const first = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hel' }] } })
    const second = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } })
    const repeat = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } })

    expect(parseCliLine(first, '')).toEqual({ kind: 'text', delta: { text: 'Hel' } })
    expect(parseCliLine(second, 'Hel')).toEqual({ kind: 'text', delta: { text: 'lo' } })
    // A repeated frame with no growth contributes nothing.
    expect(parseCliLine(repeat, 'Hello')).toEqual({ kind: 'ignored' })
  })

  it('parses a successful result event', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hello', session_id: 's1' })
    expect(parseCliLine(line, 'Hello')).toEqual({ kind: 'terminal', terminal: { kind: 'stop', sessionId: 's1' } })
  })

  it('parses an error result event', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' })
    expect(parseCliLine(line, '')).toEqual({
      kind: 'terminal',
      terminal: { kind: 'error', failure: { message: 'boom', code: 'CLI_RUN_FAILED' } },
    })
  })

  it('maps max-turns errors to max-tokens', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })
    expect(parseCliLine(line, '')).toEqual({ kind: 'terminal', terminal: { kind: 'max-turns' } })
  })
})
