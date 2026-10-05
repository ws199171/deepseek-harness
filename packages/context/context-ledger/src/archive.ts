/**
 * The mechanical session archive.
 *
 * A row is derived from a session's committed events only, with no model call, so
 * it cannot itself lose information and cannot disagree with the log it came
 * from. It is deliberately a *shape* record — how long, how many turns, which
 * files, why the last turn ended — because a summary would be a second, lossier
 * account of the same session.
 *
 * Everything here is pure and takes its inputs as arguments, so the store owns
 * all filesystem effects and tests are deterministic.
 *
 * @module dsh-context-ledger/archive
 */

import { errorMessage } from './errors.ts'

/** Version of the stored archive-row format. A future shape is a new number, not a redefinition. */
export const ARCHIVE_FORMAT_VERSION = 1

/** The counted event classes, keyed by the field they feed. */
type CountedKey = 'turns' | 'steps' | 'toolCalls' | 'compactions' | 'goalChanges'

/** Event types whose count is worth recording. */
const COUNTED_TYPES: Readonly<Record<CountedKey, string>> = Object.freeze({
  turns: 'turn/start',
  steps: 'step/start',
  toolCalls: 'tool/call',
  compactions: 'compaction/start',
  goalChanges: 'goal/change',
})

/** The least a session event must expose to be folded into a row. */
export interface ArchiveEvent {
  /** The event discriminant. */
  readonly type: string
  /** Monotonic sequence number within the session. */
  readonly seq: number
  /** Epoch milliseconds. */
  readonly time: number
  /** Event payload, narrowed by the folder per event type. */
  readonly data?: unknown
}

/** One archived session, as stored. */
export interface ArchiveRow {
  /** The stored format version. */
  readonly v: number
  /** The session this row describes. */
  readonly sessionId: string
  /** Epoch milliseconds of the first event. */
  readonly startedAt: number
  /** Epoch milliseconds of the last event. */
  readonly endedAt: number
  /** Span between the first and last event. */
  readonly elapsedMs: number
  /** Turns started. */
  readonly turns: number
  /** Steps started. */
  readonly steps: number
  /** Tool calls issued. */
  readonly toolCalls: number
  /** Compactions started. */
  readonly compactions: number
  /** Goal changes recorded. */
  readonly goalChanges: number
  /** How the last turn ended, when the log records one. */
  readonly lastTurnReason?: string | undefined
  /** The most recently touched paths, up to the ceiling, sorted. */
  readonly pathsTouched: readonly string[]
  /** Distinct paths touched, including any dropped by the ceiling. */
  readonly pathsTouchedTotal: number
}

/** The outcome of parsing a stored row. */
export type ParseArchiveRowResult =
  | { readonly ok: true; readonly row: ArchiveRow }
  | { readonly ok: false; readonly reason: string }

/**
 * Read a tool call's `file_path` argument from its raw JSON arguments string.
 *
 * @param rawArguments - The `tool/call` event's `arguments` field.
 * @returns The declared path, when there is one.
 */
function filePathOf(rawArguments: unknown): string | undefined {
  if (typeof rawArguments !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch (error) {
    // A tool may be handed arguments that are not JSON; such a call simply has no path.
    void error
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const value = (parsed as Record<string, unknown>).file_path
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Derive one archive row from a session's events.
 *
 * @param request - The derivation request.
 * @param request.sessionId - The session the events belong to.
 * @param request.events - The session's committed events, in order.
 * @param request.maxPaths - Ceiling on how many distinct paths the row carries.
 * @returns The row, or `undefined` when there is nothing to archive.
 */
export function deriveArchiveRow(request: {
  sessionId: string
  events: readonly ArchiveEvent[]
  maxPaths: number
}): ArchiveRow | undefined {
  const { sessionId, events, maxPaths } = request
  if (events.length === 0) return undefined
  const counts: Record<CountedKey, number> = {
    turns: 0,
    steps: 0,
    toolCalls: 0,
    compactions: 0,
    goalChanges: 0,
  }
  const paths = new Map<string, { time: number; seq: number }>()
  let lastTurnReason: string | undefined

  const countedKeys = Object.keys(COUNTED_TYPES) as CountedKey[]
  for (const event of events) {
    for (const key of countedKeys) {
      if (event.type === COUNTED_TYPES[key]) counts[key] += 1
    }
    if (event.type === 'turn/end') {
      const reason = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason
      if (typeof reason?.kind === 'string') lastTurnReason = reason.kind
    }
    if (event.type === 'tool/call') {
      const path = filePathOf((event.data as { arguments?: unknown } | undefined)?.arguments)
      if (path !== undefined) paths.set(path, { time: event.time, seq: event.seq })
    }
  }

  // Keep the most recently touched paths when the ceiling binds: which files a
  // session ended up working in is more useful than which it opened first.
  const ordered = [...paths.entries()]
    .sort((left, right) => right[1].time - left[1].time || right[1].seq - left[1].seq)
    .slice(0, maxPaths)
    .map(([path]) => path)
    .sort()

  const first = events[0] as ArchiveEvent
  const last = events[events.length - 1] as ArchiveEvent
  const startedAt = first.time
  const endedAt = last.time
  return Object.freeze({
    v: ARCHIVE_FORMAT_VERSION,
    sessionId,
    startedAt,
    endedAt,
    elapsedMs: Math.max(0, endedAt - startedAt),
    turns: counts.turns,
    steps: counts.steps,
    toolCalls: counts.toolCalls,
    compactions: counts.compactions,
    goalChanges: counts.goalChanges,
    ...lastTurnReason === undefined ? {} : { lastTurnReason },
    pathsTouched: Object.freeze(ordered),
    pathsTouchedTotal: paths.size,
  })
}

/**
 * Serialize a row to its stored form.
 *
 * @param row - The row.
 * @returns One JSON object per file, with a trailing newline.
 */
export function serializeArchiveRow(row: ArchiveRow): string {
  return `${JSON.stringify({
    v: row.v,
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    elapsedMs: row.elapsedMs,
    turns: row.turns,
    steps: row.steps,
    toolCalls: row.toolCalls,
    compactions: row.compactions,
    goalChanges: row.goalChanges,
    ...row.lastTurnReason === undefined ? {} : { lastTurnReason: row.lastTurnReason },
    pathsTouched: [...row.pathsTouched],
    pathsTouchedTotal: row.pathsTouchedTotal,
  })}\n`
}

/**
 * Parse a stored row.
 *
 * A file that is not a well-formed row is reported rather than thrown: the
 * archive directory is one a person may edit, so a bad file must not break a
 * listing.
 *
 * @param text - The file contents.
 * @returns The parsed row, or the reason it was not one.
 */
export function parseArchiveRow(text: string): ParseArchiveRowResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // Not written by this plugin, or damaged; the caller records the reason.
    const reason = errorMessage(error)
    return { ok: false, reason: `unparseable row: ${reason}` }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'row is not an object' }
  const row = parsed as Record<string, unknown>
  if (row.v !== ARCHIVE_FORMAT_VERSION) {
    return { ok: false, reason: `archive format version ${JSON.stringify(row.v)} is not ${ARCHIVE_FORMAT_VERSION}` }
  }
  if (typeof row.sessionId !== 'string') return { ok: false, reason: 'row is missing sessionId' }
  const numericFields = [
    'startedAt', 'endedAt', 'elapsedMs', 'turns', 'steps',
    'toolCalls', 'compactions', 'goalChanges', 'pathsTouchedTotal',
  ] as const
  for (const field of numericFields) {
    const value = row[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: `${field} is not a number` }
  }
  const rawPaths = row.pathsTouched
  if (!Array.isArray(rawPaths)) return { ok: false, reason: 'pathsTouched is not a list of strings' }
  const paths: unknown[] = rawPaths
  if (paths.some(path => typeof path !== 'string')) {
    return { ok: false, reason: 'pathsTouched is not a list of strings' }
  }
  if (row.lastTurnReason !== undefined && typeof row.lastTurnReason !== 'string') {
    return { ok: false, reason: 'lastTurnReason is not a string' }
  }
  return {
    ok: true,
    row: Object.freeze({
      v: ARCHIVE_FORMAT_VERSION,
      sessionId: row.sessionId,
      startedAt: row.startedAt as number,
      endedAt: row.endedAt as number,
      elapsedMs: row.elapsedMs as number,
      turns: row.turns as number,
      steps: row.steps as number,
      toolCalls: row.toolCalls as number,
      compactions: row.compactions as number,
      goalChanges: row.goalChanges as number,
      ...row.lastTurnReason === undefined ? {} : { lastTurnReason: row.lastTurnReason },
      pathsTouched: Object.freeze(paths as string[]),
      pathsTouchedTotal: row.pathsTouchedTotal as number,
    }),
  }
}

/**
 * Order rows newest first.
 *
 * @param rows - The rows to order.
 * @returns A new array, most recently ended first.
 */
export function orderRows(rows: readonly ArchiveRow[]): ArchiveRow[] {
  return [...rows].sort((left, right) => right.endedAt - left.endedAt || left.sessionId.localeCompare(right.sessionId))
}
