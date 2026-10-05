/**
 * Condition-triggered orchestration guidance: a reminder toward batching
 * independent concurrency-safe tool calls, and toward `run_code` when that
 * transport is actually available to the agent.
 *
 * The plugin contributes no system-prompt section and appends no session event
 * of its own type. Its only model-visible channel is one dynamic-context
 * contribution, which agent-loop records as a durable user message carrying
 * this plugin's name — the same fact `src/state.ts` folds back in, so the
 * session log alone accounts for every word the model saw and for how many
 * times the sentinel spoke.
 * @module @deepseek-ai/dsh-orchestration-sentinel
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

import { Config, CTX_NAME } from './config.ts'
import { decide } from './decide.ts'
import type { ConcurrencyKind, DecideView } from './decide.ts'
import { PROJECTION_KEY, STATE_SCHEMA, STATE_VERSION, apply as fold, init as foldInit } from './state.ts'

export const name = 'orchestration-sentinel'

/** Services this plugin cannot run without; a profile lacking one fails loudly. */
export const inject = ['tools', 'systemPrompt', 'sessionProjections']

export { Config }

/**
 * Placement of this contribution among dynamic runtime contexts.
 *
 * A literal rather than a `getContextOrder()` name: that allocation table is a
 * closed union owned by in-repo contributors. 130 sits after the repository's
 * own 110/115/120 entries, so the sentinel speaks last.
 */
const CONTEXT_ORDER = 130

/** The PTC transport's model-facing name; a platform protocol constant. */
const RUN_CODE_TOOL = 'run_code'

/**
 * Signal handed to the classification probe. The probe only resolves a
 * definition and calls its classifier, which never observes a signal; this
 * exists because the call input requires one. A shared never-aborted signal is
 * therefore correct rather than a substitute for real cancellation.
 */
const PROBE_SIGNAL = new AbortController().signal

/**
 * Build a memoized concurrency probe for one assembly.
 *
 * The probe passes `{}` as arguments because every shipped classifier is
 * argument-independent (`isConcurrencySafe: () => true`) or absent, which the
 * registry already fails closed to `exclusive`. Classification stays out of the
 * projection state: the registry can change under a live session, and a
 * checkpoint must never record a conclusion that a later registry would
 * contradict.
 * @param ctx - plugin context owning the tools service.
 * @param agent - agent whose visible tools the probe resolves.
 * @returns name → concurrency kind.
 */
function makeClassifier(ctx: Context, agent: Agent): DecideView['classify'] {
  const memo = new Map<string, ConcurrencyKind>()
  return (toolName: string): ConcurrencyKind => {
    const cached = memo.get(toolName)
    if (cached !== undefined) return cached
    const kind = ctx.tools.executionMode({
      callId: ToolCallId(`orchestration-sentinel:${toolName}`),
      name: toolName,
      arguments: {},
      agent,
      signal: PROBE_SIGNAL,
    }).kind
    memo.set(toolName, kind)
    return kind
  }
}

/**
 * Register the projection unit and the decision-bearing dynamic-context
 * contribution.
 *
 * The decision is computed inside the contribution's text provider rather than
 * in an `agent/pre-step` listener because agent-loop assembles the system prompt
 * and materializes this contribution *before* it dispatches that waterfall
 * (`packages/core/agent-loop/src/agent.ts`, `preStep`). Deciding in a listener
 * would therefore reach the model one step later than intended; deciding during
 * assembly places the reminder in the same step the model is about to write,
 * which is the only step the reminder can still influence.
 * @param ctx - the plugin's context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  /** Derived cache: the last observation logged per agent, only to avoid duplicate lines. */
  const lastLogged = new WeakMap<Agent, string>()

  ctx.effect(() => ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateSchema: STATE_SCHEMA,
    init: foldInit,
    apply: fold,
    stateVersion: STATE_VERSION,
  }), 'orchestration-sentinel: projection')

  ctx.effect(() => ctx.systemPrompt.context({
    name: CTX_NAME,
    order: CONTEXT_ORDER,
    text: (assembly) => {
      const { agent } = assembly
      if (agent === undefined) return ''
      try {
        const state = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)
        if (state === undefined) return ''
        const { text, reason } = decide(state, config, {
          turn: state.turn,
          stepIndex: state.stepIndex,
          runCodeVisible: ctx.tools.get(RUN_CODE_TOOL, agent) !== undefined,
          classify: makeClassifier(ctx, agent),
        })
        if (reason !== null) {
          const where = `${state.turn}/${state.stepIndex}/${reason}`
          if (lastLogged.get(agent) !== where) {
            lastLogged.set(agent, where)
            ctx.logger.info(config.observeOnly === true
              ? `orchestration-sentinel: would advise "${reason}" at turn ${state.turn} step ${state.stepIndex} (observe-only, nothing contributed)`
              : `orchestration-sentinel: advising "${reason}" at turn ${state.turn} step ${state.stepIndex}`)
          }
        }
        return config.observeOnly === true ? '' : text ?? ''
      } catch (error: unknown) {
        ctx.logger.warn(`orchestration-sentinel: decision failed: ${String(error)}`)
        return ''
      }
    },
  }), 'orchestration-sentinel: context')
}
