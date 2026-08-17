/**
 * Line-protocol parsing for a CLI child's stream-json output. CodeBuddy-style
 * CLIs emit one JSON object per line; this parser owns line framing, the
 * event vocabulary it understands, and the cumulative-text delta computation.
 *
 * The `assistant` event carries the FULL message content so far (cumulative,
 * not incremental), so deltas are computed against the last observed text.
 * Unknown events are ignored: the event vocabulary is merge-extensible and
 * this adapter only consumes what it maps.
 *
 * @module @deepseek-ai/dsh-llm-cli/wire
 */

import type { LlmFailure, TokenUsage } from '@deepseek-ai/dsh-llm'

/** One emitted text delta from an assistant event. */
export interface CliTextDelta {
  /** Newly observed text since the previous assistant event. */
  text: string
}

/** Terminal outcome emitted by a result event. */
export type CliTerminal =
  | { kind: 'stop'; sessionId?: string; usage?: TokenUsage }
  | { kind: 'max-turns' }
  | { kind: 'error'; failure: LlmFailure }

/** What one parsed line contributes to the adapter. */
export type CliLineEvent =
  | { kind: 'text'; delta: CliTextDelta }
  | { kind: 'terminal'; terminal: CliTerminal }
  | { kind: 'ignored' }

function asRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  void label
  return value as Record<string, unknown>
}

/** Extract the concatenated text from an assistant message content array. */
function messageText(record: Record<string, unknown>): string | undefined {
  const message = asRecord(record.message, 'message')
  if (message === undefined) return undefined
  const content = message.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const item = asRecord(block, 'content block')
    if (item === undefined) continue
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('')
}

/**
 * Parse one line of CLI stream-json output.
 * @param line - one raw stdout line (already trimmed of the newline).
 * @param lastText - the full text observed so far; deltas are computed against it.
 * @returns the event this line contributes, or undefined when the line is
 *   blank or not JSON at all.
 */
export function parseCliLine(line: string, lastText: string): CliLineEvent | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  let record: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const candidate = asRecord(parsed, 'line')
    if (candidate === undefined) return { kind: 'ignored' }
    record = candidate
  } catch {
    return { kind: 'ignored' }
  }

  const type = record.type
  if (type === 'assistant') {
    const full = messageText(record)
    if (full === undefined || full.length <= lastText.length) {
      // A repeated or empty assistant frame: no new text to emit.
      return { kind: 'ignored' }
    }
    // The CLI may re-send a slightly different prefix on some events; treat
    // only the growth beyond the previous full text as the delta.
    return { kind: 'text', delta: { text: full.slice(lastText.length) } }
  }
  if (type === 'result') {
    const isError = record.is_error === true
    const subtype = typeof record.subtype === 'string' ? record.subtype : ''
    const sessionId = typeof record.session_id === 'string' && record.session_id.length > 0
      ? record.session_id
      : undefined
    if (isError) {
      const detail = typeof record.result === 'string' && record.result.length > 0
        ? record.result
        : subtype.length > 0
          ? subtype
          : 'unknown CLI failure'
      return {
        kind: 'terminal',
        terminal: subtype.includes('max_turns') || subtype.includes('max-turns')
          ? { kind: 'max-turns' }
          : { kind: 'error', failure: { message: detail, code: 'CLI_RUN_FAILED' } },
      }
    }
    const usage = extractUsage(record)
    return {
      kind: 'terminal',
      terminal: {
        kind: 'stop',
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(usage === undefined ? {} : { usage }),
      },
    }
  }
  return { kind: 'ignored' }
}

/** Extract a TokenUsage from a result event's usage object, when complete. */
function extractUsage(record: Record<string, unknown>): TokenUsage | undefined {
  const usage = asRecord(record.usage, 'usage')
  if (usage === undefined) return undefined
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined
  return { inputTokens, outputTokens }
}
