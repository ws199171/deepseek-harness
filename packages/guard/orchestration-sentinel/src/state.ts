/**
 * The projection unit holding every fact the sentinel decides on.
 *
 * The unit is a pure fold over committed session events, so the sentinel owns
 * no authoritative state of its own: a resumed or forked session reconstructs
 * the same window and the same emission count by replaying the log. Two facts
 * are read out of the log here — the model's direct tool calls (`tool/call`)
 * and the sentinel's own emitted snapshots, which agent-loop records as
 * runtime-context user messages carrying this plugin's contribution name.
 * @module @deepseek-ai/dsh-orchestration-sentinel/state
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BUFFER_STEPS, CTX_NAME, LOOP_GUARD_SOURCE_KIND } from './config.ts'

/** Projection key this unit owns. */
export const PROJECTION_KEY = 'orchestrationSentinel'

/**
 * Persisted-state revision. Bump whenever the fields or the fold semantics
 * change so that checkpoints written by an older unit are discarded rather
 * than forward-applied into a wrong state.
 */
export const STATE_VERSION = 1

/** One step's recorded model-direct calls. */
export interface SentinelStep {
  /** Turn that owned the step. */
  turn: number
  /** Step number inside that turn, as recorded on the events. */
  step: number
  /** Names of the model-direct calls issued in that step, in model order. */
  names: string[]
}

/** Persisted fold state; plain JSON so the projection cache can checkpoint it. */
export interface SentinelState {
  /** Most recent `turn/start` turn. */
  turn: number
  /** Monotonic step ordinal inside the current turn; the cooldown unit. */
  stepIndex: number
  /** Steps of the current turn that issued at least one model-direct call. */
  steps: SentinelStep[]
  /** Emitted snapshots whose sentinel-owned text differed from the previous one. */
  emissions: number
  /** Text of this plugin's last emitted snapshot, or `null` before the first. */
  lastEmitText: string | null
  /** Turn of that snapshot, or `null`. */
  lastEmitTurn: number | null
  /** Step ordinal of that snapshot, or `null`. */
  lastEmitStepIndex: number | null
  /** Whether the shipped loop guard has already spoken inside the current turn. */
  loopGuardSpoke: boolean
}

/**
 * Structural view of one message source.
 *
 * `MessageSource` is a merge-extensible union other packages widen, and the
 * persisted form of a plugin source differs from the live one, so the fold
 * reads the two shapes it cares about by field instead of matching declared
 * members it would otherwise have to import.
 */
interface SourceView {
  readonly kind: string
  readonly plugin?: string
  readonly sections?: readonly { readonly name?: string; readonly text?: string }[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    orchestrationSentinel: SentinelState
  }
}

const stepSchema = z.object({
  turn: z.number().int(),
  step: z.number().int(),
  names: z.array(z.string()),
}).strict()

/** Persisted-state schema; rejects unknown or missing fields so a foreign checkpoint seeds a fresh fold. */
export const STATE_SCHEMA = z.object({
  turn: z.number().int(),
  stepIndex: z.number().int(),
  steps: z.array(stepSchema),
  emissions: z.number().int(),
  lastEmitText: z.string().nullable(),
  lastEmitTurn: z.number().int().nullable(),
  lastEmitStepIndex: z.number().int().nullable(),
  loopGuardSpoke: z.boolean(),
}).strict()

/**
 * State for the empty log. The session header and inherited-prefix length do
 * not participate in any decision, so they are ignored.
 * @returns the zero state.
 */
export function init(): SentinelState {
  return {
    turn: 0,
    stepIndex: 0,
    steps: [],
    emissions: 0,
    lastEmitText: null,
    lastEmitTurn: null,
    lastEmitStepIndex: null,
    loopGuardSpoke: false,
  }
}

/**
 * This plugin's contribution inside a runtime-context snapshot, or `undefined`
 * when the snapshot did not carry it.
 * @param source - structural view of the message source.
 * @returns the matching section, if any.
 */
function ownSection(source: SourceView) {
  const sections = source.sections
  // `sections === undefined` rather than `Array.isArray`: the built-in guard
  // widens to `any[]` and would erase the element type this reads.
  if (source.kind !== 'runtime-context' || sections === undefined) return undefined
  return sections.find(section => section.name === CTX_NAME)
}

/**
 * Whether one message is a reminder from the shipped loop guard, in either the
 * live (`kind`) or the persisted (`plugin`) form.
 * @param source - structural view of the message source.
 * @returns true when the guard produced this message.
 */
function isLoopGuard(source: SourceView): boolean {
  return source.kind === LOOP_GUARD_SOURCE_KIND || source.plugin === LOOP_GUARD_SOURCE_KIND
}

/**
 * Fold one committed event into the state.
 *
 * A step with no model-direct call never enters `steps`: it is not evidence
 * about batching, and including it would break a single-call run at every
 * text-only step. The buffer is per turn, because "consecutive steps" across a
 * turn boundary compares two different requests.
 * @param state - state covering all prior events.
 * @param event - the next committed event.
 * @returns the next state, or the same reference for events this unit ignores.
 */
export function apply(state: SentinelState, event: SessionEvent): SentinelState {
  switch (event.type) {
    case 'turn/start': {
      return { ...state, turn: event.data.turn, stepIndex: 0, steps: [], loopGuardSpoke: false }
    }
    case 'step/start': {
      return { ...state, stepIndex: state.stepIndex + 1 }
    }
    case 'tool/call': {
      const { turn, step, name } = event.data
      const last = state.steps.at(-1)
      const steps = last !== undefined && last.turn === turn && last.step === step
        ? [...state.steps.slice(0, -1), { turn, step, names: [...last.names, name] }]
        : [...state.steps, { turn, step, names: [name] }]
      return { ...state, steps: steps.slice(-BUFFER_STEPS) }
    }
    case 'user/message': {
      const source: SourceView = event.data.source
      if (isLoopGuard(source)) return state.loopGuardSpoke ? state : { ...state, loopGuardSpoke: true }
      const section = ownSection(source)
      if (section === undefined || typeof section.text !== 'string') return state
      if (section.text === state.lastEmitText) return state
      return {
        ...state,
        emissions: state.emissions + 1,
        lastEmitText: section.text,
        lastEmitTurn: state.turn,
        lastEmitStepIndex: state.stepIndex,
      }
    }
    default:
      return state
  }
}
