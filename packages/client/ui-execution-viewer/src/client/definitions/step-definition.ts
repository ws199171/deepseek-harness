/**
 * `execution-step` fold: one tool invocation becomes one row of the ledger.
 *
 * Identity is the tool-call id, which live argument deltas and the durable
 * `tool/call` both carry, so the transient and durable halves of one call
 * correlate into a single Context without any plugin-owned bookkeeping. The
 * fold keeps only durable facts as conclusions: a Context whose live evidence
 * disappears replays to the same result from `tool/call` and `tool/result`
 * alone.
 */
import type {
  ConversationEventRegistry, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { stepKindForTool } from '../contract/classify.ts'
import type {
  ExecutionStep, ExecutionStepError, ExecutionStepStatus, ExecutionViewNode,
} from '../contract/execution.ts'
import { boundStreamedArguments, contentText, stepTitle, summaryOf } from '../contract/format.ts'

/** One event as the Conversation engine presents it to a Definition. */
type ExecutionEvent = Parameters<ConversationNodeDefinition['match']>[0]

/** The live tool-call argument delta a stream carries. */
type ToolCallDelta = Extract<StreamChunk, { type: 'tool-call-delta' }>

/** Folded state of one tool call. */
interface StepState {
  readonly callId: string
  readonly turn: number
  readonly step: number
  readonly anchorSeq: number
  readonly name: string
  readonly argumentsRaw: string
  readonly status: Exclude<ExecutionStepStatus, 'unfinished' | 'interrupted'>
  readonly startedAt: number
  readonly callTime: number | undefined
  readonly endedAt: number | undefined
  readonly content: string | undefined
  readonly isError: boolean | undefined
  readonly error: ExecutionStepError | undefined
}

/** The live argument delta one event carries, when it carries one. */
function toolCallDelta(event: ExecutionEvent): ToolCallDelta | undefined {
  if (event.type !== 'assistant/live-chunk') return undefined
  const chunk = event.data.chunk
  return chunk.type === 'tool-call-delta' ? chunk : undefined
}

/**
 * The tool-call id one event addresses, when it addresses one.
 * @param event - one accepted event.
 * @returns the addressed call id, or undefined for an unrelated event.
 */
function eventCallId(event: ExecutionEvent): string | undefined {
  if (event.type === 'tool/call') return event.data.callId
  // `tool/result` names its call through the result message, not a payload field.
  if (event.type === 'tool/result') return event.data.message.toolCallId
  return toolCallDelta(event)?.id
}

/** Materialize one row from the folded state. */
function stepState(key: string, state: StepState): ExecutionStep {
  const kind = stepKindForTool(state.name)
  const title = stepTitle(kind, state.name, state.argumentsRaw)
  return {
    key,
    kind,
    status: state.status,
    anchorSeq: state.anchorSeq,
    turn: state.turn,
    step: state.step,
    // The call event's own clock, or the first live evidence before it lands.
    startedAt: state.callTime ?? state.startedAt,
    ...state.endedAt === undefined ? {} : { endedAt: state.endedAt },
    title,
    summary: summaryOf(title),
    detail: {
      kind: 'tool',
      name: state.name,
      argumentsRaw: state.argumentsRaw,
      ...state.content === undefined ? {} : { content: state.content },
      ...state.isError === undefined ? {} : { isError: state.isError },
    },
    ...state.error === undefined ? {} : { error: state.error },
  }
}

/** Fold one tool call's live and durable evidence into one ledger row. */
export const executionStepDefinition: ConversationNodeDefinition<StepState> = {
  kind: 'execution-step',
  target: 'execution',
  match: (event) => {
    const callId = eventCallId(event)
    if (callId === undefined) return null
    return { id: callId, role: event.type === 'tool/result' ? 'update' : 'start' }
  },
  start: (_context, match) => {
    const event = match.event
    if (event.type === 'tool/call') {
      return {
        callId: event.data.callId,
        turn: event.data.turn,
        step: event.data.step,
        anchorSeq: event.seq,
        name: event.data.name,
        argumentsRaw: event.data.arguments,
        status: 'running',
        startedAt: event.time,
        callTime: event.time,
        endedAt: undefined,
        content: undefined,
        isError: undefined,
        error: undefined,
      }
    }
    const chunk = toolCallDelta(event)
    /* v8 ignore next 3 -- match() marks only a tool-call delta or tool/call as a start. */
    if (chunk === undefined || event.type !== 'assistant/live-chunk') {
      throw new Error('execution-step requires a tool-call-delta or tool/call start event')
    }
    return {
      callId: chunk.id,
      turn: event.data.turn,
      step: event.data.step,
      anchorSeq: event.seq,
      name: chunk.name ?? '',
      argumentsRaw: '',
      status: 'preparing',
      startedAt: event.time,
      callTime: undefined,
      endedAt: undefined,
      content: undefined,
      isError: undefined,
      error: undefined,
    }
  },
  update: (context, match) => {
    const state = context.state
    const event = match.event
    const delta = toolCallDelta(event)
    if (delta !== undefined) {
      return {
        ...state,
        name: state.name === '' ? delta.name ?? '' : state.name,
        argumentsRaw: boundStreamedArguments(state.argumentsRaw + delta.argumentsDelta),
      }
    }
    if (event.type === 'tool/call') {
      // The durable call is authoritative for both the name and the arguments.
      return {
        ...state,
        name: event.data.name,
        argumentsRaw: event.data.arguments,
        status: 'running',
        callTime: event.time,
      }
    }
    /* v8 ignore next -- match() accepts only the three event types handled here. */
    if (event.type !== 'tool/result') return state
    const isError = event.data.message.isError
    return {
      ...state,
      status: isError === true || event.data.error !== undefined ? 'failed' : 'succeeded',
      endedAt: event.time,
      content: contentText(event.data.message.content),
      isError,
      error: event.data.error,
    }
  },
  publication: match => toolCallDelta(match.event) === undefined ? 'immediate' : 'animation-frame',
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const node: ExecutionViewNode = {
      key: context.key,
      kind: 'execution-step',
      id: state.callId,
      target: 'execution',
      anchorSeq: state.anchorSeq,
      turn: state.turn,
      data: stepState(context.key, state),
    }
    return node
  },
}

/**
 * Register the tool-step fold on the owning Conversation event registry.
 * @param events - the Conversation event registry.
 */
export function registerExecutionStepDefinition(events: ConversationEventRegistry): void {
  events.register(executionStepDefinition)
}
