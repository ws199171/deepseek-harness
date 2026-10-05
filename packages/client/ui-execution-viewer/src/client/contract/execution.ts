/**
 * Target-owned data model of the Execution view: one flat step per host item,
 * the snapshot a Session's builder publishes, and the view node each event
 * fold materializes.
 */
import type { ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/** What one step of the Execution ledger represents. */
export type ExecutionStepKind =
  | 'thinking'
  | 'read'
  | 'readImage'
  | 'search'
  | 'list'
  | 'write'
  | 'edit'
  | 'run'
  | 'code'
  | 'webSearch'
  | 'webFetch'
  | 'subagent'
  | 'plan'
  | 'questions'
  | 'tool'

/**
 * Lifecycle of one step. `preparing` exists only while a live tool-argument
 * delta has arrived without its durable call; `unfinished` is derived by the
 * builder from a closed Turn that never produced a result.
 */
export type ExecutionStepStatus =
  | 'preparing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unfinished'
  | 'interrupted'

/** Structured step title; the component supplies the localized copy. */
export type StepTitle =
  | { readonly kind: 'tool'; readonly name: string }
  | { readonly kind: 'path'; readonly path: string; readonly verb: 'read' | 'write' | 'edit' }
  | { readonly kind: 'query'; readonly query: string }
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'thinking'; readonly chars: number }

/** Expanded step payload; reasoning and tool steps carry different fields. */
export type StepDetail =
  | { readonly kind: 'reasoning'; readonly text: string }
  | {
    readonly kind: 'tool'
    readonly name: string
    readonly argumentsRaw: string
    readonly content?: string
    readonly isError?: boolean
  }

/** Recorded tool failure, verbatim from the `tool/result` event. */
export interface ExecutionStepError {
  /** Failure category name. */
  readonly name: string
  /** Stable failure code. */
  readonly code: string
  /** Optional provider reason. */
  readonly reason?: string
}

/** One row of the Execution ledger. */
export interface ExecutionStep {
  /** Engine Context key, used as the React identity. */
  readonly key: string
  /** Step category. */
  readonly kind: ExecutionStepKind
  /** Lifecycle state, with the builder's `unfinished` derivation applied. */
  readonly status: ExecutionStepStatus
  /** Ordering key: the earliest matched event's log sequence. */
  readonly anchorSeq: number
  /** Owning Turn number. */
  readonly turn: number
  /** Owning Step number within the Turn. */
  readonly step: number
  /** Unix epoch ms the step started. */
  readonly startedAt: number
  /** Unix epoch ms the step settled; absent while it is still running. */
  readonly endedAt?: number
  /** Structure-only title. */
  readonly title: StepTitle
  /** One-line, grapheme-bounded summary of the title's data part. */
  readonly summary: string
  /** Expanded detail payload. */
  readonly detail: StepDetail
  /** Recorded failure, when the step failed. */
  readonly error?: ExecutionStepError
}

/** One Turn's slice of the ledger. */
export interface ExecutionTurn {
  /** Turn number. */
  readonly turn: number
  /** Turn lifecycle as the Conversation engine derives it. */
  readonly status: 'open' | 'closed' | 'unknown'
  /** That Turn's steps in `anchorSeq` order. */
  readonly steps: readonly ExecutionStep[]
}

/** Complete published state of the Execution target for one Session. */
export interface ExecutionSnapshot {
  /** Turns in ascending order, each with its steps. */
  readonly turns: readonly ExecutionTurn[]
  /** Total number of steps across every Turn. */
  readonly stepCount: number
  /** Steps that are still `preparing` or `running`. */
  readonly runningCount: number
}

/** Snapshot published for a Session whose Execution target has no materialized node. */
export const EMPTY_EXECUTION_SNAPSHOT: ExecutionSnapshot = {
  turns: [],
  stepCount: 0,
  runningCount: 0,
}

/** Target-owned node the event folds materialize. */
export interface ExecutionViewNode extends ConversationViewNode {
  readonly target: 'execution'
  readonly anchorSeq: number
  readonly turn: number
  readonly data: ExecutionStep
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Independently assembled step ledger consumed by the Execution view. */
    execution: ExecutionSnapshot
  }
}

/** Selector hook over the current Conversation binding's Execution ledger. */
export type UseExecution = SnapshotSelectorHook<ExecutionSnapshot>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Selector hook over the current Conversation binding's Execution ledger. */
    useExecution: UseExecution
  }
}
