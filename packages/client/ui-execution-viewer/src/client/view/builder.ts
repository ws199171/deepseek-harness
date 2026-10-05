/**
 * Incremental builder for the Execution target: one Session's materialized
 * step nodes become turns of `anchorSeq`-ordered steps.
 *
 * The engine does not promise an order for the nodes it hands to `replace`, so
 * the builder sorts by the node's own anchor. The only derived lifecycle fact
 * here is `unfinished`: a step still waiting for its result in a Turn the
 * engine has already closed. Everything else is what the folds recorded.
 */
import type {
  ConversationTimelineSnapshot, ConversationViewBuilder,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  EMPTY_EXECUTION_SNAPSHOT, type ExecutionSnapshot, type ExecutionStep, type ExecutionStepStatus,
  type ExecutionTurn, type ExecutionViewNode,
} from '../contract/execution.ts'

/** Input one builder update receives from the assembler. */
interface BuilderInput {
  readonly timeline: ConversationTimelineSnapshot
}

/** Apply the closed-Turn derivation to one step's recorded status. */
function effectiveStatus(step: ExecutionStep, timeline: ConversationTimelineSnapshot): ExecutionStepStatus {
  if (step.status !== 'preparing' && step.status !== 'running') return step.status
  // A reasoning run reports running, succeeded, or interrupted: only a tool call
  // can be left without an answer when its Turn closes.
  if (step.kind === 'thinking') return step.status
  return timeline.turns.get(step.turn)?.status === 'closed' ? 'unfinished' : step.status
}

/** Derive one Session's published ledger from the nodes materialized so far. */
export class ExecutionViewBuilder
implements ConversationViewBuilder<ExecutionViewNode, ExecutionSnapshot> {
  readonly empty: ExecutionSnapshot = EMPTY_EXECUTION_SNAPSHOT
  private nodes = new Map<string, ExecutionViewNode>()

  /**
   * Replace the complete materialized node set and republish the ledger.
   * @param input - complete nodes and the current timeline.
   * @returns the next Execution snapshot.
   */
  replace(input: BuilderInput & { readonly nodes: readonly ExecutionViewNode[] }): ExecutionSnapshot {
    this.nodes = new Map(input.nodes.map(node => [node.key, node]))
    return this.snapshot(input.timeline)
  }

  /**
   * Merge changed nodes into the retained set and republish the ledger.
   * @param input - changed nodes and the current timeline.
   * @returns the next Execution snapshot.
   */
  apply(input: BuilderInput & { readonly upserts: readonly ExecutionViewNode[] }): ExecutionSnapshot {
    for (const node of input.upserts) this.nodes.set(node.key, node)
    return this.snapshot(input.timeline)
  }

  /** Group the retained nodes into Turn-ordered steps and count them. */
  private snapshot(timeline: ConversationTimelineSnapshot): ExecutionSnapshot {
    const ordered = [...this.nodes.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
    const byTurn = new Map<number, ExecutionStep[]>()
    for (const node of ordered) {
      const step: ExecutionStep = { ...node.data, status: effectiveStatus(node.data, timeline) }
      const steps = byTurn.get(node.turn)
      if (steps === undefined) byTurn.set(node.turn, [step])
      else steps.push(step)
    }
    const turns: ExecutionTurn[] = []
    let stepCount = 0
    let runningCount = 0
    for (const [turn, steps] of byTurn) {
      stepCount += steps.length
      for (const step of steps) {
        if (step.status === 'preparing' || step.status === 'running') runningCount += 1
      }
      turns.push({ turn, status: timeline.turns.get(turn)?.status ?? 'unknown', steps })
    }
    turns.sort((left, right) => left.turn - right.turn)
    return { turns, stepCount, runningCount }
  }
}
