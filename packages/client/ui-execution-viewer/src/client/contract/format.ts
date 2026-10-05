/**
 * Pure formatting for the Execution view: the structured title, its bounded
 * one-line summary, and the recorded text of a tool result. Every function
 * keeps recorded data verbatim — localization happens in the components.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ExecutionStepKind, StepTitle } from './execution.ts'

/** Grapheme ceiling for the collapsed row's summary and for streamed argument accumulation. */
const MAX_SUMMARY_CHARS = 160

/** Ceiling for argument text accumulated from live deltas before the durable call arrives. */
const MAX_STREAMED_ARGUMENT_CHARS = 2048

/** Grapheme-boundary segmenter shared by every truncation in this module. */
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Argument keys that name a file path, most specific first. */
const PATH_KEYS = ['file_path', 'path'] as const

/** Argument keys that name an executable command. */
const COMMAND_KEYS = ['command', 'cmd'] as const

/** Argument keys that name a search query. */
const QUERY_KEYS = ['pattern', 'query', 'queries'] as const

/** Argument keys that name a remote address. */
const URL_KEYS = ['url', 'uri'] as const

/**
 * Collapse whitespace and cut text to a grapheme ceiling, appending an ellipsis.
 * @param text - recorded text.
 * @param max - grapheme ceiling.
 * @returns the normalized, bounded text.
 */
function bound(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const chars = [...SEGMENTER.segment(normalized)].map(part => part.segment)
  return chars.length <= max ? normalized : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/**
 * Bound argument text accumulated from live deltas, which arrive in fragments
 * before the durable call replaces them with the recorded value.
 * @param raw - argument text accumulated so far.
 * @returns the text, cut at the streamed ceiling.
 */
export function boundStreamedArguments(raw: string): string {
  return raw.length <= MAX_STREAMED_ARGUMENT_CHARS ? raw : raw.slice(0, MAX_STREAMED_ARGUMENT_CHARS)
}

/**
 * Parse recorded tool arguments.
 * @param raw - the `arguments` JSON string, exactly as the model produced it.
 * @returns the parsed object, or null when the text is not a JSON object.
 */
export function parseArguments(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch (_error: unknown) {
    // Partial or free-form arguments have no structured fields to read.
    return null
  }
}

/**
 * Read the first non-empty string among `keys`.
 * @param args - parsed arguments.
 * @param keys - candidate keys in priority order.
 * @returns the first recorded value, or undefined.
 */
function firstString(args: Record<string, unknown> | null, keys: readonly string[]): string | undefined {
  if (args === null) return undefined
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
    if (Array.isArray(value) && value.every(item => typeof item === 'string') && value.length > 0) {
      return (value as readonly string[]).join(', ')
    }
  }
  return undefined
}

/**
 * Build the structure-only title of one step.
 * @param kind - step category.
 * @param name - recorded tool name; empty for a reasoning step.
 * @param argumentsRaw - recorded arguments JSON string.
 * @returns the structured title.
 */
export function stepTitle(kind: ExecutionStepKind, name: string, argumentsRaw: string): StepTitle {
  const args = parseArguments(argumentsRaw)
  if (kind === 'read' || kind === 'readImage') {
    const path = firstString(args, PATH_KEYS)
    if (path !== undefined) return { kind: 'path', path, verb: 'read' }
  }
  if (kind === 'write') {
    const path = firstString(args, PATH_KEYS)
    if (path !== undefined) return { kind: 'path', path, verb: 'write' }
  }
  if (kind === 'edit') {
    const path = firstString(args, PATH_KEYS)
    if (path !== undefined) return { kind: 'path', path, verb: 'edit' }
  }
  if (kind === 'run') {
    const command = firstString(args, COMMAND_KEYS)
    if (command !== undefined) return { kind: 'command', command }
  }
  if (kind === 'search' || kind === 'list' || kind === 'webSearch') {
    const query = firstString(args, QUERY_KEYS)
    if (query !== undefined) return { kind: 'query', query }
  }
  if (kind === 'webFetch') {
    const url = firstString(args, URL_KEYS)
    if (url !== undefined) return { kind: 'url', url }
  }
  return { kind: 'tool', name }
}

/**
 * Render a title's data part as the collapsed row's one-line summary.
 * @param title - structured title.
 * @returns the bounded data text, or an empty string when the row shows only its category.
 */
export function summaryOf(title: StepTitle): string {
  switch (title.kind) {
    case 'path': return bound(title.path, MAX_SUMMARY_CHARS)
    case 'command': return bound(title.command, MAX_SUMMARY_CHARS)
    case 'query': return bound(title.query, MAX_SUMMARY_CHARS)
    case 'url': return bound(title.url, MAX_SUMMARY_CHARS)
    case 'tool': return bound(title.name, MAX_SUMMARY_CHARS)
    case 'thinking': return ''
  }
}

/**
 * Render recorded result blocks as text; non-text blocks keep their JSON form
 * so unknown block kinds are still inspectable.
 * @param blocks - recorded result content.
 * @returns the joined text.
 */
export function contentText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    parts.push(block.type === 'text' ? block.text : JSON.stringify(block))
  }
  return parts.join('\n')
}
