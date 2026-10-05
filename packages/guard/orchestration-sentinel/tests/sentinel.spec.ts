/**
 * Loop-driven behavior: the sentinel runs inside a real agent loop against a
 * scripted mock adapter, and its only assertion surface is the durable session
 * log — the same record a reader would audit afterwards.
 * @module @deepseek-ai/dsh-orchestration-sentinel/tests/sentinel
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'

import * as Sentinel from '../src/index.ts'
import { CTX_NAME } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { testConfig } from './fixtures.ts'

/** Structural view of a logged message source; the union is merge-extensible. */
interface SourceView {
  readonly kind: string
  readonly sections?: readonly { readonly name?: string; readonly text?: string }[]
}

/**
 * Boot the core spine plus the sentinel and two fixture tools: `read` declares a
 * concurrency-safe classifier, `grep` declares none.
 * @param config - plugin config.
 * @returns the mounted context.
 */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Sentinel, testConfig(config))
  ctx.tools.register(defineContentToolFixture({
    name: 'read',
    description: 'read',
    parameters: {},
    isConcurrencySafe: () => true,
    async execute() { return [{ type: 'text' as const, text: 'ok' }] },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'grep',
    description: 'grep',
    parameters: {},
    async execute() { return [{ type: 'text' as const, text: 'ok' }] },
  }))
  return ctx
}

/**
 * Wait until one agent stops running.
 * @param ctx - mounted context.
 * @param agent - the agent to observe.
 * @returns a promise resolving on the idle transition.
 */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/**
 * Every sentinel contribution recorded in the agent's log.
 * @param agent - the agent whose log to read.
 * @returns the contributed texts, in log order.
 */
function guidance(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    .flatMap((event) => {
      const source: SourceView = event.data.source
      if (source.kind !== 'runtime-context') return []
      const mine = source.sections?.find(section => section.name === CTX_NAME)
      return typeof mine?.text === 'string' ? [mine.text] : []
    })
}

/**
 * Run one scripted session.
 * @param ctx - mounted context.
 * @param responses - adapter responses, one per assistant step.
 * @returns the agent that ran them.
 */
async function run(ctx: Context, responses: ReturnType<typeof textResponse>[]): Promise<Agent> {
  ctx.llm.registerAdapter(['mock'], new MockAdapter(responses))
  const agent = await ctx.agentLoop.create(SessionId('sentinel'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return agent
}

const singleRead = (index: number) => toolCallResponse(`c${index}`, 'read', { path: `f${index}.ts` })

/**
 * One assistant message carrying two tool calls: the batching the reminder asks
 * for, expressed at the only level the loop groups calls in parallel.
 * @param first - first call id.
 * @param second - second call id.
 * @returns the scripted response.
 */
function twoCallResponse(first: string, second: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(first), name: 'read', arguments: '{"path":"a.ts"}' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId(second), name: 'read', arguments: '{"path":"b.ts"}' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('orchestration sentinel in a live loop', () => {
  it('advises batching once, after a run of single concurrency-safe steps', async () => {
    const ctx = await harness()
    const agent = await run(ctx, [
      singleRead(1), singleRead(2), singleRead(3), singleRead(4), textResponse('done'),
    ])

    const found = guidance(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('these 3 steps each issued exactly one tool call')
    expect(found[0]).toContain('turn 1, step 1–3')
  })

  it('goes quiet once the model batches, and stays quiet after that', async () => {
    const ctx = await harness({ cooldownSteps: 0 })
    const agent = await run(ctx, [
      singleRead(1), singleRead(2), singleRead(3),
      twoCallResponse('c4a', 'c4b'),
      twoCallResponse('c5a', 'c5b'),
      twoCallResponse('c6a', 'c6b'),
      textResponse('done'),
    ])

    const found = guidance(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('turn 1, step 1–3')
  })

  it('contributes nothing in observe-only mode', async () => {
    const ctx = await harness({ observeOnly: true })
    const agent = await run(ctx, [
      singleRead(1), singleRead(2), singleRead(3), singleRead(4), textResponse('done'),
    ])

    expect(guidance(agent)).toHaveLength(0)
  })

  it('stays silent when the repeated tool is not concurrency-safe', async () => {
    const ctx = await harness()
    const agent = await run(ctx, [
      toolCallResponse('g1', 'grep', { pattern: 'a' }),
      toolCallResponse('g2', 'grep', { pattern: 'b' }),
      toolCallResponse('g3', 'grep', { pattern: 'c' }),
      toolCallResponse('g4', 'grep', { pattern: 'd' }),
      textResponse('done'),
    ])

    expect(guidance(agent)).toHaveLength(0)
  })

  it('falls back to the batching reminder when run_code is not available', async () => {
    const ctx = await harness({ windowSteps: 6, repeatedToolCalls: 4 })
    const agent = await run(ctx, [
      singleRead(1), singleRead(2), singleRead(3), singleRead(4), singleRead(5), singleRead(6),
      textResponse('done'),
    ])

    const found = guidance(agent)
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]).toContain('these 3 steps')
    expect(found.join('\n')).not.toContain('run_code')
  })
})
