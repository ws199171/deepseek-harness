/** Slot rows this plugin declares for its own view. */
import type { ExecutionStep } from './execution.ts'

/** Owner data one step-detail render receives. */
export interface ExecutionDetailOwnerProps {
  /** The step whose full detail is rendered. */
  readonly step: ExecutionStep
  /** Zero-based position of the step within its Turn, for copy and ordering. */
  readonly index: number
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Detail body of one expanded Execution step. The Execution view renders
     * this slot for whatever component is registered, so a deployment can
     * replace the shipped panel without touching the ledger.
     */
    'conversation.execution.detail': {
      kind: 'single'
      scope: 'session'
      owner: ExecutionDetailOwnerProps
    }
  }
}
