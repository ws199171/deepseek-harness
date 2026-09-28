import { describe, expect, it } from 'vitest'
import { parseCliLine } from '../src/wire.ts'

/** Render one CLI stream-json frame. */
function frame(value: unknown): string {
  return JSON.stringify(value)
}

/** Render one cumulative assistant frame carrying `text`. */
function assistantFrame(text: string): string {
  return frame({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
}

describe('parseCliLine framing', () => {
  it('returns undefined for blank lines', () => {
    expect(parseCliLine('', '')).toBeUndefined()
    expect(parseCliLine('   ', '')).toBeUndefined()
  })

  it('ignores anything that is not a JSON object', () => {
    expect(parseCliLine('not json at all', '')).toEqual({ kind: 'ignored' })
    expect(parseCliLine('null', '')).toEqual({ kind: 'ignored' })
    expect(parseCliLine('[]', '')).toEqual({ kind: 'ignored' })
    expect(parseCliLine('7', '')).toEqual({ kind: 'ignored' })
  })

  it('ignores event types this adapter does not map', () => {
    expect(parseCliLine(frame({ type: 'system', subtype: 'init' }), '')).toEqual({ kind: 'ignored' })
  })
})

describe('parseCliLine assistant frames', () => {
  it('computes deltas against the cumulative text it is given', () => {
    expect(parseCliLine(assistantFrame('Hel'), '')).toEqual({ kind: 'text', delta: { text: 'Hel' } })
    expect(parseCliLine(assistantFrame('Hello'), 'Hel')).toEqual({ kind: 'text', delta: { text: 'lo' } })
  })

  it('ignores a repeated or shortened frame', () => {
    expect(parseCliLine(assistantFrame('Hello'), 'Hello')).toEqual({ kind: 'ignored' })
    expect(parseCliLine(assistantFrame('He'), 'Hello')).toEqual({ kind: 'ignored' })
  })

  it('ignores a frame with no readable message text', () => {
    expect(parseCliLine(frame({ type: 'assistant' }), '')).toEqual({ kind: 'ignored' })
    expect(parseCliLine(frame({ type: 'assistant', message: { content: 'text' } }), '')).toEqual({ kind: 'ignored' })
    const mixed = frame({
      type: 'assistant',
      message: { content: ['scalar', { type: 'tool_use', name: 'x' }, { type: 'text', text: 7 }] },
    })
    expect(parseCliLine(mixed, '')).toEqual({ kind: 'ignored' })
  })
})

describe('parseCliLine result frames', () => {
  it('reports a stop with its session id and complete usage', () => {
    const line = frame({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's1',
      usage: { input_tokens: 10, output_tokens: 3 },
    })
    expect(parseCliLine(line, 'Hello')).toEqual({
      kind: 'terminal',
      terminal: { kind: 'stop', sessionId: 's1', usage: { inputTokens: 10, outputTokens: 3 } },
    })
  })

  it('reports a stop without a session id or usage', () => {
    expect(parseCliLine(frame({ type: 'result', subtype: 'success' }), ''))
      .toEqual({ kind: 'terminal', terminal: { kind: 'stop' } })
  })

  it('reports a stop when usage is present but incomplete', () => {
    const line = frame({ type: 'result', is_error: false, usage: { input_tokens: 10 } })
    expect(parseCliLine(line, '')).toEqual({ kind: 'terminal', terminal: { kind: 'stop' } })
  })

  it('reports the CLI\'s own detail for a failed run', () => {
    const line = frame({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' })
    expect(parseCliLine(line, '')).toEqual({
      kind: 'terminal',
      terminal: { kind: 'error', failure: { message: 'boom', code: 'CLI_RUN_FAILED' } },
    })
  })

  it('falls back to the subtype, then to a generic detail', () => {
    expect(parseCliLine(frame({ type: 'result', subtype: 'error_odd', is_error: true }), ''))
      .toEqual({ kind: 'terminal', terminal: { kind: 'error', failure: { message: 'error_odd', code: 'CLI_RUN_FAILED' } } })
    expect(parseCliLine(frame({ type: 'result', is_error: true, result: 7 }), ''))
      .toEqual({ kind: 'terminal', terminal: { kind: 'error', failure: { message: 'unknown CLI failure', code: 'CLI_RUN_FAILED' } } })
  })

  it('maps a turn-limit failure to max-tokens', () => {
    expect(parseCliLine(frame({ type: 'result', subtype: 'error_max_turns', is_error: true }), ''))
      .toEqual({ kind: 'terminal', terminal: { kind: 'max-turns' } })
    expect(parseCliLine(frame({ type: 'result', subtype: 'hit max-turns', is_error: true }), ''))
      .toEqual({ kind: 'terminal', terminal: { kind: 'max-turns' } })
  })

  it('treats a non-full session id as absent', () => {
    expect(parseCliLine(frame({ type: 'result', session_id: '' }), ''))
      .toEqual({ kind: 'terminal', terminal: { kind: 'stop' } })
    expect(parseCliLine(frame({ type: 'result', session_id: 7 }), ''))
      .toEqual({ kind: 'terminal', terminal: { kind: 'stop' } })
  })
})
