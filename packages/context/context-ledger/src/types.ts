/**
 * The seam between the plugin's wiring and its model-facing tools.
 *
 * These are the values `contextFor` resolves once per tool call and the state the
 * adaptive budget reports. They live here rather than in one consumer so the
 * wiring and the tools cannot disagree about what a tool is handed.
 *
 * @module @deepseek-ai/dsh-context-ledger/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { BudgetSpec } from './budget.ts'
import type { Entry } from './entry.ts'
import type { LedgerStore } from './store.ts'

/**
 * The token-meter capability the ledger reads, and no more.
 *
 * Narrowing each optional service to the methods actually called keeps the seam
 * honest: `ctx.get('tokenMeter')` satisfies this structurally, and a test can
 * supply a plain object with no cast.
 */
export interface UsageMeter {
  /**
   * Measure the session's log.
   *
   * @param session - The session to measure.
   * @returns The measurement, of which the ledger reads `totalTokens`.
   */
  measure: (session: Session) => { totalTokens: number }
}

/** The model-router capability the ledger reads, and no more. */
export interface ModelWindowResolver {
  /**
   * Resolve the routed model's declared context window.
   *
   * @param provider - The provider id from the session's request header.
   * @param model - The model id from the session's request header.
   * @param signal - Cancellation for the lookup.
   * @returns Model information, of which the ledger reads `context.contextWindow`.
   */
  resolveModelInfo: (
    provider: string,
    model: string,
    signal?: AbortSignal,
  ) => Promise<{ context?: { contextWindow?: number } }>
}

/** The approval capability `ledger_promote` asks, and no more. */
export interface PromotionApprover {
  /**
   * Ask a human to confirm one recorded fact.
   *
   * @param request - The approval request, including the fact's own tool call.
   * @returns The outcome; the ledger promotes only on `allowed-once`.
   */
  request: (request: {
    agent: Agent
    toolName: string
    callId: ToolCallId
    reason: string
    signal: AbortSignal
  }) => Promise<string>
}

/**
 * The concrete services a deployment composes. Kept as the seam's vocabulary so
 * the wiring can be checked against the real classes without the tools depending
 * on them.
 */
export type ComposedServices = {
  readonly tokenMeter: TokenMeter | undefined
  readonly llm: LlmRuntime | undefined
  readonly approval: ApprovalService | undefined
}

/** The rendered block a session currently has cached, and what produced it. */
export interface CachedBlock {
  /** The rendered block text, exactly as injected. */
  readonly text: string
  /** The project root the block was rendered for. */
  readonly root: string
  /** Every stored entry the block was rendered from. */
  readonly entries: readonly Entry[]
}

/** How a session's budget rung was decided. */
export interface AdaptiveState {
  /** The configured profile name, `adaptive` included. */
  readonly configured: string
  /** The rung actually in force. */
  readonly rung: string
  /** Free-window fraction the adaptive mode may spend. */
  readonly ratio: number
  /** Tokens the session's log occupied at the last checkpoint. */
  readonly usedTokens?: number
  /** The routed model's window at the last checkpoint. */
  readonly contextWindow?: number
  /** Which figures were available, and why the others were not. */
  readonly basis: string
}

/** Everything one `ledger_*` tool call needs, resolved from its execution. */
export interface LedgerToolContext {
  /** The calling agent; `contextFor` refuses a call that has none. */
  readonly agent: Agent
  /** The calling session's project store. */
  readonly store: LedgerStore
  /** The ceilings in force for the calling session. */
  readonly budget: BudgetSpec
  /** The rung decision behind those ceilings. */
  readonly adaptive: AdaptiveState
  /** The resolved project root. */
  readonly projectRoot: string
  /** The block currently cached for the calling session. */
  readonly cached: CachedBlock
  /** The calling session. */
  readonly session: Session
  /** The token meter service, when composed. */
  readonly tokenMeter: UsageMeter | undefined
  /** The model service, when composed. */
  readonly llm: ModelWindowResolver | undefined
  /** The approval surface, when composed. */
  readonly approval: PromotionApprover | undefined
}
