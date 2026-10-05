/**
 * Session token accounting.
 *
 * Shared by the adaptive rung chooser and by `ledger_status`, so the two can
 * never disagree about what the session is using. Compaction does not expose
 * usage, so the window is resolved from the routed model independently and a
 * route that cannot be resolved costs only the window figure.
 *
 * @module dsh-context-ledger/usage
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { errorMessage } from './errors.ts'
import type { ModelWindowResolver, UsageMeter } from './types.ts'

/** What one reading of the session's usage established. */
export interface UsageReading {
  /** Tokens the session's log currently occupies, when a meter is composed. */
  readonly usedTokens?: number
  /** The routed model's window, when the route resolves and declares one. */
  readonly contextWindow?: number
  /** Window minus usage, when both are known. */
  readonly remainingTokens?: number
  /** Which figures were available, and why the others were not. */
  readonly basis: string
}

/**
 * Attach the measured figures that are actually known.
 *
 * Unknown figures are omitted rather than set to `undefined`: under
 * `exactOptionalPropertyTypes` an absent optional property and a present one
 * holding `undefined` are different types, and the tool output schema this value
 * satisfies declares the former.
 *
 * @param usedTokens - Tokens used, when a meter is composed.
 * @param basis - Which figures were available, and why the others were not.
 * @param contextWindow - The routed model's window, when it declares one.
 * @returns The reading.
 */
function reading(usedTokens: number | undefined, basis: string, contextWindow?: number): UsageReading {
  return {
    ...usedTokens === undefined ? {} : { usedTokens },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...usedTokens === undefined || contextWindow === undefined ? {} : { remainingTokens: contextWindow - usedTokens },
    basis,
  }
}

/**
 * Read the routed model's context window and the session's current usage.
 *
 * @param request - The read request.
 * @param request.session - The session to measure.
 * @param request.tokenMeter - The token meter service, when composed.
 * @param request.llm - The model service, when composed.
 * @param request.signal - Cancellation for the model-info lookup.
 * @returns Used tokens, window, remainder, and the basis each figure came from.
 */
export async function readUsage(request: {
  session: Session
  tokenMeter: UsageMeter | undefined
  llm: ModelWindowResolver | undefined
  signal?: AbortSignal | undefined
}): Promise<UsageReading> {
  const { session, tokenMeter, llm, signal } = request
  const usedTokens = tokenMeter === undefined ? undefined : tokenMeter.measure(session).totalTokens
  const header = session.requestHeader()
  if (llm === undefined || header === undefined || header.config.provider.length === 0) {
    return reading(usedTokens, 'token meter only; no routed model is resolvable')
  }
  try {
    const info = await llm.resolveModelInfo(header.config.provider, header.config.model, signal)
    const contextWindow = info.context?.contextWindow
    if (contextWindow === undefined) {
      return reading(usedTokens, 'the routed model does not declare a context window')
    }
    return reading(usedTokens, `${header.config.provider}/${header.config.model}`, contextWindow)
  } catch (error) {
    // The route could not be resolved; usage is still reportable without the window.
    const reason = errorMessage(error)
    return reading(usedTokens, `context window unavailable: ${reason}`)
  }
}
