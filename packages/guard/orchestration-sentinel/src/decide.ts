/**
 * The decision function: everything the sentinel considers, with no I/O.
 *
 * It reads the log-derived projection state, the validated config, and a small
 * view of the current step, and returns the text to contribute plus which
 * mechanism produced it. Concurrency classification arrives as an injected
 * probe because it belongs to the tool registry, not to the log: classifying
 * inside the fold would let a later registry change rewrite recorded history.
 * @module @deepseek-ai/dsh-orchestration-sentinel/decide
 */

import type { Config } from './config.ts'
import { ptcText, splitText } from './guidance.ts'
import type { SplitObservation, RepeatObservation } from './guidance.ts'
import type { SentinelState } from './state.ts'

/** Which mechanism produced a decision. */
export type SentinelReason = 'split' | 'ptc'

/** The decision for one step. */
export interface Decision {
  /** Text to contribute, or `null` to contribute nothing. */
  text: string | null
  /** Mechanism that fired, or `null` when nothing fired. */
  reason: SentinelReason | null
}

/** Concurrency classification for one tool name. */
export type ConcurrencyKind = 'parallel' | 'exclusive'

/** The facts this step supplies to {@link decide}. */
export interface DecideView {
  /** Turn the proposed step belongs to. */
  turn: number
  /** Step ordinal of the last started step; the cooldown unit. */
  stepIndex: number
  /** Whether `run_code` is visible to this agent, making a PTC suggestion actionable. */
  runCodeVisible: boolean
  /** Classifies one tool name through the agent's visible tool definitions. */
  classify: (toolName: string) => ConcurrencyKind
}

/**
 * Whether the trailing steps form a run of single concurrency-safe calls.
 * @param state - projection state.
 * @param config - validated plugin config.
 * @param classify - name → concurrency kind probe.
 * @returns the observed run, or `null` when the run does not hold.
 */
function findSplit(
  state: SentinelState,
  config: Config,
  classify: DecideView['classify'],
): SplitObservation | null {
  const need = config.singleCallStreak as number
  if (state.steps.length < need) return null
  const window = state.steps.slice(-need)
  for (const entry of window) {
    if (entry.names.length !== 1) return null
    if (classify(entry.names[0] as string) !== 'parallel') return null
  }
  const first = window[0] as (typeof window)[number]
  const last = window[window.length - 1] as (typeof window)[number]
  return { turn: first.turn, firstStep: first.step, lastStep: last.step, count: need }
}

/**
 * The repeated concurrency-safe tool call with the largest count in the window.
 * Ties break on the tool name so the choice is deterministic.
 * @param state - projection state.
 * @param config - validated plugin config.
 * @param classify - name → concurrency kind probe.
 * @returns the observed repeat, or `null` when none qualifies.
 */
function findRepeat(
  state: SentinelState,
  config: Config,
  classify: DecideView['classify'],
): RepeatObservation | null {
  const window = state.steps.slice(-(config.windowSteps as number))
  if (window.length === 0) return null
  interface Tally {
    count: number
    parallel: boolean
    firstStep: number
    lastStep: number
  }
  const tally = new Map<string, Tally>()
  for (const entry of window) {
    for (const name of entry.names) {
      const record = tally.get(name) ?? { count: 0, parallel: true, firstStep: entry.step, lastStep: entry.step }
      record.count += 1
      record.lastStep = entry.step
      if (classify(name) !== 'parallel') record.parallel = false
      tally.set(name, record)
    }
  }
  const threshold = config.repeatedToolCalls as number
  const candidates = [...tally].filter(([, record]) => record.count >= threshold && record.parallel)
  if (candidates.length === 0) return null
  // Tally keys are tool names and therefore unique, so equality never reaches
  // the comparator's second branch.
  candidates.sort(([leftName, left], [rightName, right]) =>
    right.count - left.count || (leftName < rightName ? -1 : 1))
  const [tool, record] = candidates[0] as [string, Tally]
  const first = window[0] as (typeof window)[number]
  return {
    turn: first.turn,
    firstStep: record.firstStep,
    lastStep: record.lastStep,
    tool,
    count: record.count,
  }
}

/**
 * Decide this step's contribution.
 *
 * Suppression is ordered: disabled, then the session emission budget, then the
 * in-turn cooldown, then the mechanisms. `observeOnly` is applied after the
 * mechanisms rather than before them so observation mode still reports which
 * mechanism would have fired — that rate is the measurement the observation
 * phase exists to produce.
 *
 * Compliance is not a branch here: a step with two or more calls breaks a
 * single-call run in the state itself, and a repeat count simply stops growing.
 * A turn in which the shipped loop guard already told the model it is looping
 * suppresses the PTC suggestion, because repeating one operation verbatim is
 * the guard's finding, not a batching opportunity.
 * @param state - log-derived projection state.
 * @param config - validated plugin config.
 * @param view - current step facts and the injected classification probe.
 * @returns the text to contribute (or `null`) and the mechanism that fired.
 */
export function decide(state: SentinelState, config: Config, view: DecideView): Decision {
  if (config.enabled !== true) return { text: null, reason: null }
  if (state.emissions >= (config.maxEmissions as number)) return { text: null, reason: null }
  if (state.lastEmitTurn === view.turn
    && state.lastEmitStepIndex !== null
    && view.stepIndex - state.lastEmitStepIndex < (config.cooldownSteps as number)) {
    return { text: null, reason: null }
  }
  const ptcEligible = config.enablePtcSuggestion === true && view.runCodeVisible && !state.loopGuardSpoke
  const repeat = ptcEligible ? findRepeat(state, config, view.classify) : null
  const split = repeat === null && config.enableSplit === true
    ? findSplit(state, config, view.classify)
    : null
  if (repeat === null && split === null) return { text: null, reason: null }
  const reason: SentinelReason = repeat === null ? 'split' : 'ptc'
  if (config.observeOnly === true) return { text: null, reason }
  return { text: repeat === null ? splitText(split as SplitObservation) : ptcText(repeat), reason }
}
