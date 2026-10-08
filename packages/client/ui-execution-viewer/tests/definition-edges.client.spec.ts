/**
 * Fold edge behavior and the registration surfaces: a nameless live delta
 * starts a step before its name arrives, the target Definition exposes its
 * builder and activity test, and both plugin halves register through the
 * Cordis context they are given.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition, ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  ConversationEventRegistry, ConversationNodeAssembler, ConversationViewRegistry,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { apply as applyNodeHalf } from '../src/index.ts'
import {
  executionStepDefinition, registerExecutionStepDefinition,
} from '../src/client/definitions/step-definition.ts'
import {
  executionThinkingDefinition, registerExecutionThinkingDefinition,
} from '../src/client/definitions/thinking-definition.ts'
import type { ExecutionSnapshot } from '../src/client/contract/execution.ts'
import { ExecutionViewBuilder } from '../src/client/view/builder.ts'
import {
  executionViewDefinition, registerExecutionConversationView,
} from '../src/client/view/view-definition.ts'
import { resetLog, liveToolDelta, toolCall, toolResult, turnEnd, turnStart } from './fixtures.client.ts'

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

beforeEach(() => { resetLog() })

describe('step fold edges', () => {
  it('names a step once a later delta carries the tool name', () => {
    const value = assembler([
      turnStart(1),
      liveToolDelta(1, 1, 'call-1', '{"file_'),
      liveToolDelta(1, 1, 'call-1', 'path":"a"}', 'read'),
      toolCall(1, 1, 'call-1', 'read', '{"file_path":"a"}'),
      toolResult(1, 1, 'call-1', 'body'),
      turnEnd(1),
    ])
    const [step] = snapshot(value).turns[0]?.steps ?? []
    expect(step?.kind).toBe('read')
    expect(step?.title).toEqual({ kind: 'path', path: 'a', verb: 'read' })
  })

  it('shows a still-nameless step through its category alone', () => {
    const value = assembler([
      turnStart(1),
      liveToolDelta(1, 1, 'call-1', '{"file_'),
      liveToolDelta(1, 1, 'call-1', 'path":"a"}'),
    ])
    const [step] = snapshot(value).turns[0]?.steps ?? []
    expect(step?.kind).toBe('tool')
    expect(step?.summary).toBe('')
    expect(step?.status).toBe('preparing')
  })
})

describe('Execution target registration', () => {
  it('creates a fresh builder and reports activity only with steps', () => {
    expect(executionViewDefinition.target).toBe('execution')
    expect(executionViewDefinition.create()).toBeInstanceOf(ExecutionViewBuilder)
    expect(executionViewDefinition.isActive?.({ turns: [], stepCount: 0, runningCount: 0 })).toBe(false)
    expect(executionViewDefinition.isActive?.({
      turns: [], stepCount: 1, runningCount: 0,
    })).toBe(true)
  })

  it('registers both folds and the target on the Conversation registries', () => {
    const ctx = new Context()
    const events = new ConversationEventRegistry(ctx)
    const views = new ConversationViewRegistry(ctx)
    registerExecutionStepDefinition(events)
    registerExecutionThinkingDefinition(events)
    registerExecutionConversationView(views)
    expect(events.entries().map(definition => definition.kind))
      .toEqual(['execution-step', 'execution-thinking'])
    expect(views.entries()).toEqual([executionViewDefinition])
  })

  it('exposes a Host half with no behavior', () => {
    expect(applyNodeHalf()).toBeUndefined()
  })
})
