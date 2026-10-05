/**
 * The two guidance texts.
 *
 * Both texts are a pure function of the observed window, including the turn and
 * the covered step range. That uniqueness is load-bearing: agent-loop records a
 * runtime-context snapshot only when its text changes, so an unchanged window
 * produces no new snapshot (no repeated cost), and a snapshot re-emitted after
 * compaction repeats the same text and is therefore not counted as a second
 * intervention.
 *
 * Both texts describe only what was observed and attach a conditional
 * suggestion. Neither asserts that any two already-executed calls were
 * mergeable, and neither claims to know whether a dependency exists.
 * @module @deepseek-ai/dsh-orchestration-sentinel/guidance
 */

/** The window a batching reminder describes. */
export interface SplitObservation {
  /** Turn the observed steps belong to. */
  turn: number
  /** First step of the run. */
  firstStep: number
  /** Last step of the run. */
  lastStep: number
  /** How many steps the run covers. */
  count: number
}

/** The repeat a `run_code` suggestion describes. */
export interface RepeatObservation {
  /** Turn the observed steps belong to. */
  turn: number
  /** First step where the tool appeared. */
  firstStep: number
  /** Last step where the tool appeared. */
  lastStep: number
  /** The repeated tool name. */
  tool: string
  /** How many times it was called inside the window. */
  count: number
}

/**
 * Render a step range as one readable span.
 * @param firstStep - first step in the span.
 * @param lastStep - last step in the span.
 * @returns a single number or an en dash span.
 */
function span(firstStep: number, lastStep: number): string {
  return firstStep === lastStep ? `${firstStep}` : `${firstStep}–${lastStep}`
}

/**
 * Render the shared `[orchestration] (turn T, steps A–B)` prefix.
 * @param turn - turn the observed steps belong to.
 * @param firstStep - first step in the span.
 * @param lastStep - last step in the span.
 * @returns the prefix.
 */
function prefix(turn: number, firstStep: number, lastStep: number): string {
  return `[orchestration] (turn ${turn}, step ${span(firstStep, lastStep)})`
}

/**
 * The batching reminder for a run of single-call steps.
 * @param observation - the observed run.
 * @returns the contribution text.
 */
export function splitText(observation: SplitObservation): string {
  const { turn, firstStep, lastStep, count } = observation
  return `${prefix(turn, firstStep, lastStep)}: these ${count} steps each issued exactly one tool call. `
    + 'If the read-only work still ahead of you in this step does not depend on an earlier result, '
    + 'issue those calls together in one message; the harness schedules concurrency-safe calls in one '
    + 'message in parallel.'
}

/**
 * The `run_code` suggestion for a repeated tool call.
 * @param observation - the observed repeat.
 * @returns the contribution text.
 */
export function ptcText(observation: RepeatObservation): string {
  const { turn, firstStep, lastStep, tool, count } = observation
  return `${prefix(turn, firstStep, lastStep)}: ${tool} has been called ${count} times. `
    + 'If the work left is one operation repeated over a set of inputs, run_code can do it in a single call.'
}
