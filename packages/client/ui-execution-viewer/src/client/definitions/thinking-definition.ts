/**
 * `execution-thinking` fold: one reasoning run per Turn/Step.
 *
 * Identity is the `(turn, step)` pair rather than the attempt id, because a
 * durable settlement carries no attempt id — only its own coordinates. Using
 * the attempt id would leave replayed history unable to find the Context its
 * live deltas started. Durable reasoning records are authoritative: they
 * replace whatever the live deltas accumulated.
 */
import type {
  ConversationEventRegistry, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import type { ExecutionStep, ExecutionStepStatus, ExecutionViewNode } from '../contract/execution.ts'

/** One event as the Conversation engine presents it to a Definition. */
type ExecutionEvent = Parameters<ConversationNodeDefinition['match']>[0]

/** A durable reasoning record. */
type ReasoningRecord = Extract<AssistantStreamRecord, { type: 'reasoning-chunks' }>

/** Folded state of one reasoning run. */
interface ThinkingState {
  readonly turn: number
  readonly step: number
  readonly anchorSeq: number
  readonly text: string
  readonly status: Exclude<ExecutionStepStatus, 'preparing' | 'failed' | 'unfinished'>
  readonly startedAt: number
  readonly endedAt: number | undefined
}

/** Reasoning text joined from its records, with the span they recorded. */
interface ReasoningRun {
  readonly text: string
  readonly startedAt: number
  readonly endedAt: number
}

/** The reasoning record one accepted event carries, when it carries one. */
function reasoningRecord(event: ExecutionEvent): ReasoningRecord | undefined {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  for (const record of event.data.stream) {
    if (record.type === 'reasoning-chunks') return record
  }
  return undefined
}

/**
 * Read the reasoning run one durable settlement recorded.
 * @param stream - the settlement's compact stream.
 * @returns the joined text and its recorded span, or undefined without reasoning.
 */
function reasoningRun(stream: readonly AssistantStreamRecord[]): ReasoningRun | undefined {
  let text = ''
  let startedAt: number | undefined
  let endedAt: number | undefined
  for (const record of stream) {
    if (record.type !== 'reasoning-chunks') continue
    text += record.texts.join('')
    startedAt = startedAt === undefined ? record.time0 : Math.min(startedAt, record.time0)
    let member = record.time0
    for (const gap of record.dt) {
      member += gap
      endedAt = endedAt === undefined ? member : Math.max(endedAt, member)
    }
    endedAt = endedAt === undefined ? record.time0 : Math.max(endedAt, record.time0)
  }
  /* v8 ignore next -- a caller reaches this only after match() found a reasoning record. */
  if (startedAt === undefined || endedAt === undefined) return undefined
  return { text, startedAt, endedAt }
}

/** The `(turn, step)` identity both the live and durable halves carry. */
function runId(turn: number, step: number): string {
  return `${turn}:${step}`
}

/** Materialize one row from the folded state. */
function thinkingState(key: string, state: ThinkingState): ExecutionStep {
  return {
    key,
    kind: 'thinking',
    status: state.status,
    anchorSeq: state.anchorSeq,
    turn: state.turn,
    step: state.step,
    startedAt: state.startedAt,
    ...state.endedAt === undefined ? {} : { endedAt: state.endedAt },
    title: { kind: 'thinking', chars: state.text.length },
    summary: '',
    detail: { kind: 'reasoning', text: state.text },
  }
}

/** Fold one reasoning run's live and durable evidence into one ledger row. */
export const executionThinkingDefinition: ConversationNodeDefinition<ThinkingState> = {
  kind: 'execution-thinking',
  target: 'execution',
  match: (event) => {
    if (event.type === 'assistant/live-chunk') {
      return event.data.chunk.type === 'reasoning-delta'
        ? { id: runId(event.data.turn, event.data.step), role: 'start' }
        : null
    }
    if (reasoningRecord(event) === undefined) return null
    return { id: runId(event.data.turn, event.data.step), role: 'start' }
  },
  start: (_context, match) => {
    const event = match.event
    if (event.type === 'assistant/live-chunk') {
      const chunk = event.data.chunk
      /* v8 ignore next 3 -- match() marks only a reasoning delta as a live start. */
      if (chunk.type !== 'reasoning-delta') {
        throw new Error('execution-thinking requires a reasoning-delta or settlement start event')
      }
      return {
        turn: event.data.turn,
        step: event.data.step,
        anchorSeq: event.seq,
        text: chunk.text,
        status: 'running',
        startedAt: event.time,
        endedAt: undefined,
      }
    }
    /* v8 ignore next 4 -- match() marks only the two settlements as a durable start. */
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') {
      throw new Error('execution-thinking requires a reasoning-delta or settlement start event')
    }
    const run = reasoningRun(event.data.stream)
    /* v8 ignore next 3 -- match() requires a reasoning run before marking a settlement. */
    if (run === undefined) {
      throw new Error('execution-thinking requires a reasoning-delta or settlement start event')
    }
    const interrupted = event.type === 'assistant/message' && event.data.interrupted === true
    return {
      turn: event.data.turn,
      step: event.data.step,
      anchorSeq: event.seq,
      text: run.text,
      status: interrupted ? 'interrupted' : 'succeeded',
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    }
  },
  update: (context, match) => {
    const state = context.state
    const event = match.event
    if (event.type === 'assistant/live-chunk') {
      const chunk = event.data.chunk
      /* v8 ignore next -- match() starts this fold only on a reasoning delta. */
      if (chunk.type !== 'reasoning-delta') return state
      return { ...state, text: state.text + chunk.text, status: 'running' }
    }
    /* v8 ignore next 2 -- match() accepts only the two settlements past the live branch. */
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
    const run = reasoningRun(event.data.stream)
    /* v8 ignore next -- match() requires a reasoning run before marking a settlement. */
    if (run === undefined) return state
    const interrupted = event.type === 'assistant/message' && event.data.interrupted === true
    return {
      ...state,
      text: run.text,
      status: interrupted ? 'interrupted' : 'succeeded',
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    }
  },
  publication: (match) => {
    if (match.event.type === 'assistant/live-chunk') return 'animation-frame'
    return 'immediate'
  },
  buildViewNode: (context) => {
    const state = context.state
    /* v8 ignore next -- the engine materializes a node only for a started Context. */
    if (state === undefined) return null
    const node: ExecutionViewNode = {
      key: context.key,
      kind: 'execution-thinking',
      id: runId(state.turn, state.step),
      target: 'execution',
      anchorSeq: state.anchorSeq,
      turn: state.turn,
      data: thinkingState(context.key, state),
    }
    return node
  },
}

/**
 * Register the reasoning fold on the owning Conversation event registry.
 * @param events - the Conversation event registry.
 */
export function registerExecutionThinkingDefinition(events: ConversationEventRegistry): void {
  events.register(executionThinkingDefinition)
}
