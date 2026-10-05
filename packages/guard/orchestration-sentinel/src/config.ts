/**
 * Configuration, constants, and the two shared names of the orchestration
 * sentinel. The sentinel nudges the model toward batching independent
 * concurrency-safe calls and, when the PTC transport is actually available to
 * the agent, toward `run_code`.
 * @module @deepseek-ai/dsh-orchestration-sentinel/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * Name of the dynamic-context contribution this plugin registers. It is the
 * identity the plugin reads back out of the session log to count its own
 * emissions, so the registration name and this constant must never drift.
 */
export const CTX_NAME = 'orchestration:sentinel'

/**
 * Hard cap on the per-turn step buffer kept in projection state.
 *
 * Fixed rather than configurable because it bounds a checkpointed projection:
 * {@link Config.windowSteps} and {@link Config.singleCallStreak} are capped at
 * 8, so a buffer of 16 always covers the widest window either mechanism can
 * inspect. Raising either config ceiling requires raising this constant and
 * bumping `STATE_VERSION` in `src/state.ts`.
 */
export const BUFFER_STEPS = 16

/**
 * Source kind the shipped loop guard stamps on its own reminders. The sentinel
 * reads it only to stay silent when that guard has already told the model it is
 * looping, because a `run_code` suggestion in that situation would codify the
 * loop rather than shorten it. Reading a name is weaker than depending on the
 * package: when the guard is absent the kind never appears and nothing changes.
 */
export const LOOP_GUARD_SOURCE_KIND = 'repeat-tool-reminder'

/**
 * Plugin configuration, validated by the same-named schemastery schema. Every
 * field is checked when the plugin activates; an out-of-range or wrongly typed
 * value fails activation instead of being silently clamped.
 */
export interface Config {
  /** Whether the sentinel runs at all. */
  enabled?: boolean
  /**
   * Compute the decision but contribute no context text: the observation mode
   * that measures how often an intervention window appears before any guidance
   * is injected.
   */
  observeOnly?: boolean
  /** Trailing steps the repeated-tool (PTC) window inspects. */
  windowSteps?: number
  /** Consecutive single-call steps that trigger the batching reminder. */
  singleCallStreak?: number
  /** Occurrences of one tool inside the window that trigger the PTC suggestion. */
  repeatedToolCalls?: number
  /** Minimum steps between two emissions inside the same turn. */
  cooldownSteps?: number
  /** Emissions allowed per session; `0` suppresses every emission and every observation record. */
  maxEmissions?: number
  /** Whether the batching mechanism is eligible. */
  enableSplit?: boolean
  /** Whether the PTC mechanism is eligible; `run_code` visibility still gates it. */
  enablePtcSuggestion?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  observeOnly: z.boolean().default(false),
  windowSteps: z.natural().min(1).max(8).default(4),
  singleCallStreak: z.natural().min(1).max(8).default(3),
  repeatedToolCalls: z.natural().min(2).max(32).default(6),
  cooldownSteps: z.natural().min(0).max(32).default(3),
  maxEmissions: z.natural().min(0).max(32).default(3),
  enableSplit: z.boolean().default(true),
  enablePtcSuggestion: z.boolean().default(true),
})
