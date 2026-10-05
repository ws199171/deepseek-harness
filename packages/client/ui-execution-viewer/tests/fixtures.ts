/** Typed Session-event fixtures for the Execution viewer's fold tests. */
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  AssistantStreamRecord, LlmAttemptId, MessageId, StreamChunk, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Wall clock every fixture time is offset from. */
export const T0 = 1_700_000_000_000

/** Milliseconds between two consecutively stamped fixtures. */
const STEP_MS = 100

let sequence = 0

/** Clear the log counter so anchors and times are reproducible per test. */
export function resetLog(): void {
  sequence = 0
}

/**
 * Allocate the next log sequence and its wall clock.
 * @param time - explicit wall clock, for events whose absolute time two windows must agree on.
 */
function stamp(time?: number): { readonly seq: SessionSeq; readonly time: number } {
  sequence += 1
  return { seq: sequence as SessionSeq, time: time ?? T0 + sequence * STEP_MS }
}

/** Wrap one durable event as a history entry. */
function durable(event: SessionEvent): SessionEventLikeEntry {
  return { type: 'event', event }
}

/** Wrap one transient live-chunk presentation as a history entry. */
function transient(
  seq: SessionSeq,
  time: number,
  turn: number,
  step: number,
  chunk: StreamChunk,
): SessionEventLikeEntry {
  return {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq,
      time,
      data: { attemptId: 'attempt-1' as LlmAttemptId, turn, step, chunk },
    },
  }
}

/** One `turn/start` boundary. */
export function turnStart(turn: number, at?: number): SessionEventLikeEntry {
  const { seq, time } = stamp(at)
  return durable({ type: 'turn/start', seq, time, data: { turn } })
}

/** One `turn/end` boundary. */
export function turnEnd(turn: number, at?: number): SessionEventLikeEntry {
  const { seq, time } = stamp(at)
  return durable({ type: 'turn/end', seq, time, data: { turn } })
}

/** One committed `tool/call`. */
export function toolCall(
  turn: number, step: number, callId: string, name: string, args: string, at?: number,
): SessionEventLikeEntry {
  const { seq, time } = stamp(at)
  return durable({
    type: 'tool/call',
    seq,
    time,
    data: { turn, step, callId: callId as ToolCallId, name, arguments: args },
  })
}

/** One committed `tool/result`. */
export function toolResult(
  turn: number,
  step: number,
  callId: string,
  content: string,
  options: {
    readonly isError?: boolean
    readonly error?: { readonly name: string; readonly code: string; readonly reason?: string }
    readonly at?: number
  } = {},
): SessionEventLikeEntry {
  const { seq, time } = stamp(options.at)
  return durable({
    type: 'tool/result',
    seq,
    time,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: {
        id: `tool-${seq}` as MessageId,
        role: 'tool',
        content: [{ type: 'text', text: content }],
        source: { kind: 'tool', callId: callId as ToolCallId },
        toolCallId: callId as ToolCallId,
        ...options.isError === undefined ? {} : { isError: options.isError },
      },
      ...options.error === undefined ? {} : { error: options.error },
    },
  })
}

/** One committed `assistant/message` settlement. */
export function assistantMessage(
  turn: number,
  step: number,
  stream: readonly AssistantStreamRecord[],
  options: { readonly interrupted?: true; readonly at?: number } = {},
): SessionEventLikeEntry {
  const { seq, time } = stamp(options.at)
  return durable({
    type: 'assistant/message',
    seq,
    time,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: {
        id: `assistant-${seq}` as MessageId,
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
      stream: [...stream],
      ...options.interrupted === undefined ? {} : { interrupted: options.interrupted },
    },
  })
}

/** One committed `assistant/attempt` settlement carrying no surface message. */
export function assistantAttempt(
  turn: number, step: number, stream: readonly AssistantStreamRecord[], at?: number,
): SessionEventLikeEntry {
  const { seq, time } = stamp(at)
  return durable({
    type: 'assistant/attempt',
    seq,
    time,
    data: { turn, step, stream: [...stream] },
  })
}

/** One live reasoning delta. */
export function liveReasoning(
  turn: number, step: number, text: string, at?: number,
): SessionEventLikeEntry {
  const { seq, time } = stamp(at)
  return transient(seq, time, turn, step, { type: 'reasoning-delta', index: 0, text })
}

/** One live tool-call argument delta. */
export function liveToolDelta(
  turn: number, step: number, callId: string, argumentsDelta: string, name?: string, at?: number,
): SessionEventLikeEntry {
  const { seq, time } = stamp(at)
  return transient(seq, time, turn, step, {
    type: 'tool-call-delta',
    index: 0,
    id: callId as ToolCallId,
    ...name === undefined ? {} : { name },
    argumentsDelta,
  })
}

/**
 * Build one durable reasoning record.
 * @param time0 - wall clock of the first member.
 * @param texts - member texts.
 * @param gaps - inter-member gaps; `texts.length - 1` entries.
 * @returns the compact record.
 */
export function reasoningRecord(
  time0: number, texts: readonly string[], gaps: readonly number[],
): AssistantStreamRecord {
  return { type: 'reasoning-chunks', time0, index: 0, dt: gaps, texts }
}

/** Build one durable text record. */
export function textRecord(time0: number, texts: readonly string[]): AssistantStreamRecord {
  return { type: 'text-chunks', time0, index: 1, dt: [], texts }
}
