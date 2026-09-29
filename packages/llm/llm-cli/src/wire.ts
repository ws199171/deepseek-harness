/**
 * Line-protocol parsing for a CLI child's stream-json output. CodeBuddy-style
 * CLIs emit one JSON object per line; this parser owns line framing, the event
 * vocabulary it understands, and the text-delta computation.
 *
 * Two line families carry answer text, and a run may produce either or both:
 * `stream_event` frames wrap the model request's own SSE events when the child
 * is asked for partial messages, so text arrives while it is still being
 * generated; and the completed `assistant` frame repeats the whole message once
 * the message ends. Both are measured against the text already observed *for
 * the message in progress*, which is why `message_start` is reported rather
 * than ignored — it is the only boundary a caller has for resetting that
 * measurement. A frame adding nothing beyond the text already seen is ignored,
 * so a run reading both families emits each character once.
 *
 * Unknown events are ignored: the event vocabulary is merge-extensible and this
 * adapter only consumes what it maps.
 *
 * @module @deepseek-ai/dsh-llm-cli/wire
 */

import type { LlmFailure, TokenUsage } from '@deepseek-ai/dsh-llm'

/** One emitted text delta, from a partial message or from a completed one. */
export interface CliTextDelta {
  /** Newly observed text since the previous frame of the message in progress. */
  text: string
}

/** Terminal outcome of one CLI run, as reported by its result event. */
export type CliTerminal =
  | { kind: 'stop'; sessionId?: string; usage?: TokenUsage }
  | { kind: 'max-turns' }
  | { kind: 'error'; failure: LlmFailure }

/** What one parsed line contributes to the adapter. */
export type CliLineEvent =
  | { kind: 'message-start' }
  | { kind: 'text'; delta: CliTextDelta }
  | { kind: 'terminal'; terminal: CliTerminal }
  | { kind: 'ignored' }

/** Narrow a parsed JSON value to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Parse one line as JSON; a non-JSON line is a diagnostic outside the protocol. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Extract the concatenated text from an assistant message content array. */
function messageText(record: Record<string, unknown>): string | undefined {
  const message = asRecord(record.message)
  if (message === undefined) return undefined
  const content = message.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const item = asRecord(block)
    if (item !== undefined && item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('')
}

/** Extract a complete {@link TokenUsage} from a result event, when it carries one. */
function extractUsage(record: Record<string, unknown>): TokenUsage | undefined {
  const usage = asRecord(record.usage)
  if (usage === undefined) return undefined
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined
  return { inputTokens, outputTokens }
}

/** Describe a failed result event, from its own detail or from its subtype. */
function failureOf(record: Record<string, unknown>, subtype: string): LlmFailure {
  const detail = typeof record.result === 'string' && record.result.length > 0
    ? record.result
    : subtype.length > 0
      ? subtype
      : 'unknown CLI failure'
  return { message: detail, code: 'CLI_RUN_FAILED' }
}

/** Read the terminal a result event reports. */
function terminalOf(record: Record<string, unknown>): CliTerminal {
  const subtype = typeof record.subtype === 'string' ? record.subtype : ''
  if (record.is_error === true) {
    return subtype.includes('max_turns') || subtype.includes('max-turns')
      ? { kind: 'max-turns' }
      : { kind: 'error', failure: failureOf(record, subtype) }
  }
  const sessionId = typeof record.session_id === 'string' && record.session_id.length > 0
    ? record.session_id
    : undefined
  const usage = extractUsage(record)
  return {
    kind: 'stop',
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(usage === undefined ? {} : { usage }),
  }
}

/**
 * Read the SSE event a partial-message line wraps.
 * @param record - the parsed stream-json line.
 * @returns the wrapped event, or undefined when the line is not one.
 */
function streamEventOf(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (record.type !== 'stream_event') return undefined
  return asRecord(record.event)
}

/**
 * Read the text one SSE event contributes to the message being generated.
 * @param event - the wrapped SSE event.
 * @returns the incremental text, or undefined for any event that carries none.
 */
function partialTextOf(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'content_block_delta') return undefined
  const delta = asRecord(event.delta)
  if (delta === undefined || delta.type !== 'text_delta') return undefined
  const text = delta.text
  // An empty delta would open a text block for nothing.
  return typeof text === 'string' && text.length > 0 ? text : undefined
}

/**
 * Parse one line of CLI stream-json output.
 * @param line - one raw stdout line (already stripped of its newline).
 * @param lastText - the text observed so far for the message in progress; a delta is measured against it.
 * @returns the event this line contributes, or undefined when the line is blank.
 */
export function parseCliLine(line: string, lastText: string): CliLineEvent | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  const record = asRecord(parseJson(trimmed))
  if (record === undefined) return { kind: 'ignored' }
  const streamEvent = streamEventOf(record)
  if (streamEvent !== undefined) {
    if (streamEvent.type === 'message_start') return { kind: 'message-start' }
    const text = partialTextOf(streamEvent)
    return text === undefined ? { kind: 'ignored' } : { kind: 'text', delta: { text } }
  }
  if (record.type === 'assistant') {
    const full = messageText(record)
    // A repeated, shortened, or empty assistant frame contributes no new text.
    if (full === undefined || full.length <= lastText.length) return { kind: 'ignored' }
    return { kind: 'text', delta: { text: full.slice(lastText.length) } }
  }
  if (record.type === 'result') return { kind: 'terminal', terminal: terminalOf(record) }
  return { kind: 'ignored' }
}
