/**
 * Shared fixtures for the orchestration-sentinel suites: a fully populated
 * config, typed session-event builders matching the real envelope, and the
 * test-only declaration of the loop guard's source kind this suite fabricates.
 * @module @deepseek-ai/dsh-orchestration-sentinel/tests/fixtures
 */

import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { CTX_NAME } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { apply, init } from '../src/state.ts'
import type { SentinelState } from '../src/state.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'repeat-tool-reminder': { kind: 'repeat-tool-reminder' } & ContextFormed
  }
}

/**
 * A fully populated config, matching what schemastery hands `apply`.
 * @param overrides - fields to replace.
 * @returns the config.
 */
export function testConfig(overrides: Config = {}): Config {
  const defaults: Config = {
    enabled: true,
    observeOnly: false,
    windowSteps: 4,
    singleCallStreak: 3,
    repeatedToolCalls: 6,
    cooldownSteps: 3,
    maxEmissions: 3,
    enableSplit: true,
    enablePtcSuggestion: true,
  }
  return Object.assign(defaults, overrides)
}

let seq = 0

/** @returns a `turn/start` event. */
export const turnStart = (turn: number): SessionEvent =>
  ({ type: 'turn/start', seq: SessionSeq(seq++), time: seq, data: { turn } })

/** @returns a `step/start` event. */
export const stepStart = (turn: number, step: number): SessionEvent =>
  ({ type: 'step/start', seq: SessionSeq(seq++), time: seq, data: { turn, step } })

/** @returns a model-direct `tool/call` event. */
export const toolCall = (turn: number, step: number, name: string): SessionEvent =>
  ({
    type: 'tool/call',
    seq: SessionSeq(seq++),
    time: seq,
    data: { turn, step, callId: ToolCallId(`${name}:${turn}:${step}:${seq}`), name, arguments: '{}' },
  })

/** @returns a `step/end` event, which the fold ignores. */
export const stepEnd = (turn: number, step: number): SessionEvent =>
  ({ type: 'step/end', seq: SessionSeq(seq++), time: seq, data: { turn, step } })

/**
 * A runtime-context snapshot carrying this plugin's contribution.
 * @param text - the sentinel's contributed text.
 * @returns the `user/message` event.
 */
export const snapshot = (text: string): SessionEvent => ({
  type: 'user/message',
  seq: SessionSeq(seq++),
  time: seq,
  data: createUserMessage({
    content: [{ type: 'text', text: `Current runtime context.\n\n${text}` }],
    source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: CTX_NAME, text }] },
  }),
  surfaceOp: 'append',
})

/** @returns a runtime-context snapshot that does not carry this plugin's name. */
export const foreignSnapshot = (text: string): SessionEvent => ({
  type: 'user/message',
  seq: SessionSeq(seq++),
  time: seq,
  data: createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'other:plugin', text }] },
  }),
  surfaceOp: 'append',
})

/** @returns the "all contexts cleared" marker, which carries no sections. */
export const clearedMarker = (): SessionEvent => ({
  type: 'user/message',
  seq: SessionSeq(seq++),
  time: seq,
  data: createUserMessage({
    content: [{ type: 'text', text: 'Current runtime context: none.' }],
    source: { kind: 'runtime-context' },
  }),
  surfaceOp: 'append',
})

/** @returns a reminder from the shipped loop guard. */
export const loopGuardNotice = (): SessionEvent => ({
  type: 'user/message',
  seq: SessionSeq(seq++),
  time: seq,
  data: createUserMessage({
    content: [{ type: 'text', text: 'You are repeating the exact same tool call.' }],
    source: { kind: 'repeat-tool-reminder', form: 'notice', summary: 'read × 3' },
  }),
  surfaceOp: 'append',
})

/** @returns an ordinary user message. */
export const userMessage = (text: string): SessionEvent => ({
  type: 'user/message',
  seq: SessionSeq(seq++),
  time: seq,
  data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  surfaceOp: 'append',
})

/**
 * Fold a whole event list from the empty state.
 * @param events - committed events in order.
 * @returns the final state.
 */
export function foldAll(events: readonly SessionEvent[]): SentinelState {
  return events.reduce<SentinelState>(apply, init())
}

/**
 * A turn in which every listed step issued the given calls.
 * @param turn - turn number.
 * @param steps - one array of tool names per step.
 * @returns the event list.
 */
export function turnOf(turn: number, steps: readonly (readonly string[])[]): SessionEvent[] {
  const events: SessionEvent[] = [turnStart(turn)]
  steps.forEach((names, index) => {
    const step = index + 1
    events.push(stepStart(turn, step))
    for (const name of names) events.push(toolCall(turn, step, name))
    events.push(stepEnd(turn, step))
  })
  return events
}
