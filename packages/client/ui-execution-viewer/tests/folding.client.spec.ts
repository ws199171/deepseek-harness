/**
 * Fold acceptance on the real Conversation assembler: the Execution target
 * rebuilds one ledger row per host item from durable events alone, keeps the
 * durable value when live evidence is present, and produces the same ledger
 * through every assembly path (replace, prepend-after-update-only, live append).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ConversationNodeDefinition, ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { executionStepDefinition } from '../src/client/definitions/step-definition.ts'
import { executionThinkingDefinition } from '../src/client/definitions/thinking-definition.ts'
import type { ExecutionSnapshot, ExecutionStep } from '../src/client/contract/execution.ts'
import { executionViewDefinition } from '../src/client/view/view-definition.ts'
import {
  assistantAttempt, assistantMessage, liveReasoning, liveToolDelta, reasoningRecord, resetLog,
  textRecord, toolCall, toolResult, turnEnd, turnStart,
} from './fixtures.client.ts'

const REGISTERED: readonly ConversationNodeDefinition[] = [executionStepDefinition, executionThinkingDefinition]

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return REGISTERED
  }

  fallbackEntry(): undefined {
    return undefined
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [executionViewDefinition]
  }
}

/** Assemble one window and activate the Execution target. */
function assembler(entries: readonly SessionEventLikeEntry[]): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, false)
  value.activateTarget('execution')
  return value
}

/** Read the Execution ledger out of one assembler. */
function snapshot(value: ConversationNodeAssembler): ExecutionSnapshot {
  const current = value.get('execution')
  if (current === undefined) throw new Error('execution target was not registered')
  return current
}

/** Flatten one snapshot's steps in ledger order. */
function steps(value: ConversationNodeAssembler): readonly ExecutionStep[] {
  return snapshot(value).turns.flatMap(turn => turn.steps)
}

beforeEach(() => { resetLog() })

describe('Execution step fold', () => {
  it('rebuilds a settled step from durable events alone', () => {
    const value = assembler([
      turnStart(1),
      toolCall(1, 1, 'call-1', 'read', '{"file_path":"src/a.ts"}'),
      toolResult(1, 1, 'call-1', 'file body'),
      turnEnd(1),
    ])
    const [step] = steps(value)
    expect(step?.kind).toBe('read')
    expect(step?.status).toBe('succeeded')
    expect(step?.title).toEqual({ kind: 'path', path: 'src/a.ts', verb: 'read' })
    expect(step?.summary).toBe('src/a.ts')
    expect(step?.detail).toEqual({
      kind: 'tool', name: 'read', argumentsRaw: '{"file_path":"src/a.ts"}', content: 'file body',
    })
    expect(step?.endedAt !== undefined && step.startedAt !== undefined).toBe(true)
    expect(snapshot(value).stepCount).toBe(1)
    expect(snapshot(value).runningCount).toBe(0)
    expect(snapshot(value).turns[0]?.status).toBe('closed')
  })

  it('records a failure with its code and marks an unanswered call unfinished', () => {
    const value = assembler([
      turnStart(1),
      toolCall(1, 1, 'call-1', 'bash', '{"command":"ls"}'),
      toolResult(1, 1, 'call-1', 'boom', { error: { name: 'ToolError', code: 'E_FAIL', reason: 'nope' } }),
      toolCall(1, 2, 'call-2', 'read', '{}'),
      turnEnd(1),
    ])
    const [failed, unfinished] = steps(value)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toEqual({ name: 'ToolError', code: 'E_FAIL', reason: 'nope' })
    expect(failed?.title).toEqual({ kind: 'command', command: 'ls' })
    expect(unfinished?.status).toBe('unfinished')
  })

  it('treats a provider-reported error flag as a failure', () => {
    const value = assembler([
      turnStart(1),
      toolCall(1, 1, 'call-1', 'read', '{}'),
      toolResult(1, 1, 'call-1', 'denied', { isError: true }),
      turnEnd(1),
    ])
    expect(steps(value)[0]?.status).toBe('failed')
  })

  it('classifies an unknown tool name as a plain tool step and keeps its name', () => {
    const value = assembler([
      turnStart(1),
      toolCall(1, 1, 'call-1', 'mcp__server__do_thing', '{}'),
      toolResult(1, 1, 'call-1', 'ok'),
      turnEnd(1),
    ])
    const [step] = steps(value)
    expect(step?.kind).toBe('tool')
    expect(step?.title).toEqual({ kind: 'tool', name: 'mcp__server__do_thing' })
    expect(step?.summary).toBe('mcp__server__do_thing')
  })

  it('keeps the durable call value when live deltas preceded it', () => {
    const value = assembler([
      turnStart(1),
      liveToolDelta(1, 1, 'call-1', '{"file_', 'read'),
      liveToolDelta(1, 1, 'call-1', 'path":"src/b.ts"}'),
      toolCall(1, 1, 'call-1', 'read', '{"file_path":"src/b.ts"}'),
      toolResult(1, 1, 'call-1', 'body'),
      turnEnd(1),
    ])
    const [step] = steps(value)
    expect(step?.detail).toEqual({
      kind: 'tool', name: 'read', argumentsRaw: '{"file_path":"src/b.ts"}', content: 'body',
    })
    expect(step?.title).toEqual({ kind: 'path', path: 'src/b.ts', verb: 'read' })
  })

  it('shows a live call as preparing before its durable call arrives', () => {
    const value = assembler([
      turnStart(1),
      liveToolDelta(1, 1, 'call-1', '{"file_', 'read'),
    ])
    expect(steps(value)[0]?.status).toBe('preparing')
    expect(snapshot(value).runningCount).toBe(1)
  })
})

describe('Execution reasoning fold', () => {
  it('rebuilds reasoning text and span from a durable settlement', () => {
    const value = assembler([
      turnStart(1),
      assistantMessage(1, 1, [reasoningRecord(2_000, ['think ', 'hard'], [50])]),
      turnEnd(1),
    ])
    const [step] = steps(value)
    expect(step?.kind).toBe('thinking')
    expect(step?.status).toBe('succeeded')
    expect(step?.detail).toEqual({ kind: 'reasoning', text: 'think hard' })
    expect(step?.startedAt).toBe(2_000)
    expect(step?.endedAt).toBe(2_050)
    expect(step?.title).toEqual({ kind: 'thinking', chars: 10 })
  })

  it('marks an interrupted settlement as interrupted', () => {
    const value = assembler([
      turnStart(1),
      assistantMessage(1, 1, [reasoningRecord(2_000, ['cut'], [])], { interrupted: true }),
      turnEnd(1),
    ])
    expect(steps(value)[0]?.status).toBe('interrupted')
  })

  it('settles a message attempt with no reasoning record as no step', () => {
    const value = assembler([
      turnStart(1),
      assistantMessage(1, 1, [textRecord(2_000, ['answer'])]),
      turnEnd(1),
    ])
    expect(steps(value)).toHaveLength(0)
  })

  it('joins every reasoning record a settlement carries and ignores its other records', () => {
    const value = assembler([
      turnStart(1),
      assistantMessage(1, 1, [
        textRecord(3_000, ['answer']),
        reasoningRecord(5_000, ['first'], [20, 30]),
        reasoningRecord(4_000, ['second'], []),
      ]),
      turnEnd(1),
    ])
    const [step] = steps(value)
    expect(step?.detail).toEqual({ kind: 'reasoning', text: 'firstsecond' })
    // The span covers the earliest record start and the latest member clock.
    expect(step?.startedAt).toBe(4_000)
    expect(step?.endedAt).toBe(5_050)
  })

  it('settles a live run as interrupted when the settlement says so', () => {
    const value = assembler([
      turnStart(1),
      liveReasoning(1, 1, 'draft'),
      assistantMessage(1, 1, [reasoningRecord(6_000, ['cut'], [])], { interrupted: true }),
      turnEnd(1),
    ])
    const [step] = steps(value)
    expect(step?.status).toBe('interrupted')
    expect(step?.detail).toEqual({ kind: 'reasoning', text: 'cut' })
  })

  it('lets the durable settlement replace text accumulated from live deltas', () => {
    const value = assembler([
      turnStart(1),
      liveReasoning(1, 1, 'draft '),
      liveReasoning(1, 1, 'only'),
      assistantAttempt(1, 1, [reasoningRecord(3_000, ['final'], [])]),
      turnEnd(1),
    ])
    const [step] = steps(value)
    expect(step?.detail).toEqual({ kind: 'reasoning', text: 'final' })
    expect(step?.status).toBe('succeeded')
  })

  it('streams live reasoning while the attempt is unsettled', () => {
    const value = assembler([
      turnStart(1),
      liveReasoning(1, 1, 'first '),
      liveReasoning(1, 1, 'second'),
    ])
    const [step] = steps(value)
    expect(step?.detail).toEqual({ kind: 'reasoning', text: 'first second' })
    expect(step?.status).toBe('running')
    expect(snapshot(value).runningCount).toBe(1)
  })
})

describe('Execution ledger assembly paths', () => {
  const durable = (): readonly SessionEventLikeEntry[] => [
    turnStart(1),
    toolCall(1, 1, 'call-1', 'read', '{"file_path":"a"}'),
    toolResult(1, 1, 'call-1', 'body'),
    turnEnd(1),
  ]

  // Keys and anchors are log positions, and the three paths reach them from
  // different windows, so the comparison is over the conclusions the ledger
  // reports rather than over its positions.
  const conclusions = (value: ConversationNodeAssembler) => steps(value).map(step => ({
    kind: step.kind,
    status: step.status,
    title: step.title,
    summary: step.summary,
    detail: step.detail,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
    turn: step.turn,
    step: step.step,
    error: step.error,
  }))

  it('reaches the same conclusions when the start arrives after an update-only tail', () => {
    const window = durable()
    const replacement = assembler(window)
    const incremental = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
    incremental.replaceWindow([window[2] as SessionEventLikeEntry], false)
    incremental.activateTarget('execution')
    expect(snapshot(incremental).stepCount).toBe(0)
    incremental.prepend([
      window[0] as SessionEventLikeEntry,
      window[1] as SessionEventLikeEntry,
      window[3] as SessionEventLikeEntry,
    ], false)
    incremental.flush()
    expect(conclusions(incremental)).toEqual(conclusions(replacement))
    expect(snapshot(incremental).turns[0]?.status).toBe('closed')
  })

  it('reaches the same conclusions when live events append onto loaded history', () => {
    const window = durable()
    const streaming = [
      turnStart(2),
      liveReasoning(2, 1, 'more'),
      assistantMessage(2, 1, [reasoningRecord(4_000, ['settled'], [])]),
      turnEnd(2),
    ]
    const replacement = assembler([...window, ...streaming])
    const incremental = assembler(window)
    for (const entry of streaming) incremental.append(entry)
    incremental.flush()
    expect(conclusions(incremental)).toEqual(conclusions(replacement))
  })

  it('reaches the same conclusions without any live evidence at all', () => {
    // Absolute times are properties of the recorded events, so both windows
    // state them explicitly; only the log positions differ between them.
    const durableEvents = () => [
      turnStart(1, 2_000),
      toolCall(1, 1, 'call-1', 'read', '{"file_path":"a"}', 2_100),
      toolResult(1, 1, 'call-1', 'body', { at: 2_200 }),
      assistantMessage(1, 1, [reasoningRecord(2_000, ['settled'], [])], { at: 2_300 }),
      turnEnd(1, 2_400),
    ] as const
    const withLive = assembler([
      liveToolDelta(1, 1, 'call-1', '{"file_path":"a"}', 'read', 1_900),
      liveReasoning(1, 1, 'draft', 1_950),
      ...durableEvents(),
    ])
    const durableOnly = assembler([...durableEvents()])
    expect(conclusions(withLive)).toEqual(conclusions(durableOnly))
  })

  it('orders steps by anchor and partitions them by turn', () => {
    const value = assembler([
      turnStart(1),
      toolCall(1, 1, 'call-1', 'read', '{}'),
      toolResult(1, 1, 'call-1', 'a'),
      turnStart(2),
      liveReasoning(2, 1, 'thinking'),
      toolCall(2, 1, 'call-2', 'bash', '{"command":"pwd"}'),
      toolResult(2, 1, 'call-2', 'out'),
      turnEnd(2),
    ])
    const current = snapshot(value)
    expect(current.turns.map(turn => turn.turn)).toEqual([1, 2])
    expect(current.turns[1]?.steps.map(step => step.kind)).toEqual(['thinking', 'run'])
    expect(current.stepCount).toBe(3)
    expect(steps(value)[0]?.anchorSeq).toBeLessThan(steps(value)[1]?.anchorSeq ?? 0)
  })
})
