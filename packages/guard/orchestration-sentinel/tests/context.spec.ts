/**
 * Provider-level behavior for the branches a live loop cannot reach: a bare
 * assembly with no agent, a log that has recorded no call yet, a repeated
 * identical observation, a classifier that is missing, refuses, or throws, and
 * a reader that throws.
 *
 * The loop-driven suite in `sentinel.spec.ts` is the evidence that the sentinel
 * works end to end; this suite exists because those branches are about the
 * contribution contract rather than about the model.
 * @module @deepseek-ai/dsh-orchestration-sentinel/tests/context
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import type { AssembleContext, PromptContext } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import * as Sentinel from '../src/index.ts'
import { CTX_NAME } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { init } from '../src/state.ts'
import type { SentinelState } from '../src/state.ts'
import { testConfig } from './fixtures.ts'

/** One stubbed registry, contribution capture and agent, wired per test. */
interface Harness {
  ctx: Context
  agent: Agent
  /** Evaluate the registered contribution the way assembly would. */
  contribute: (assembly: AssembleContext) => string
  contribution: () => PromptContext
  /** Replace what the retained projection handle folds for any session. */
  setState: (impl: (() => SentinelState) | SentinelState) => void
  /** Make one definition visible to the agent's tools. */
  setTool: (tool: ToolDefinition) => void
  /** Every `tools.get` lookup, in call order. */
  lookups: { name: string; agent: unknown }[]
  infos: string[]
  warnings: string[]
}

/** A tool definition whose classifier answers as the test asks. */
function tool(name: string, isConcurrencySafe?: (args: unknown) => boolean): ToolDefinition {
  return defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    ...isConcurrencySafe === undefined ? {} : { isConcurrencySafe },
    async execute() { return [{ type: 'text' as const, text: 'ok' }] },
  })
}

/**
 * Boot a bare context whose three injected services are stubs, so the provider
 * can be called directly with the assembly the test chooses.
 * @param config - plugin config overrides.
 * @returns the harness.
 */
async function harness(config: Config = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('sentinel-context'))
  const agent = { id: session.id, ctx, session } as Agent

  let stateOfImpl: () => SentinelState = () => init()
  let captured: PromptContext | undefined
  const infos: string[] = []
  const warnings: string[] = []
  const lookups: Harness['lookups'] = []
  const definitions = new Map<string, ToolDefinition>()

  ctx.provide('sessionProjections', {
    // Registration resolves asynchronously to the handle this plugin retains;
    // the stub answers with one reader over the test's own fold.
    register: async () => ({
      stateOf: (_session: Session) => stateOfImpl(),
      dispose: async () => {},
    }),
  })
  ctx.provide('systemPrompt', {
    context: (contribution: PromptContext) => {
      captured = contribution
      return () => {}
    },
  })
  ctx.provide('tools', {
    get: (name: string, scope?: unknown) => {
      lookups.push({ name, agent: scope })
      return definitions.get(name)
    },
  })
  vi.spyOn(ctx.logger, 'info').mockImplementation((...parts: unknown[]) => { infos.push(parts.join(' ')) })
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...parts: unknown[]) => { warnings.push(parts.join(' ')) })

  await ctx.plugin(Sentinel, testConfig(config))
  return {
    ctx,
    agent,
    contribution: () => {
      if (captured === undefined) throw new Error('the plugin registered no contribution')
      return captured
    },
    contribute: (assembly) => {
      const contribution = captured
      if (contribution === undefined) throw new Error('the plugin registered no contribution')
      const { text } = contribution
      // The plugin must contribute a dynamic provider: its text depends on the
      // window, so a static string would be a different plugin.
      if (typeof text !== 'function') throw new Error('the plugin contributed static text')
      return text(assembly)
    },
    setState: (impl) => {
      stateOfImpl = typeof impl === 'function' ? impl : () => impl
    },
    setTool: (definition) => { definitions.set(definition.name, definition) },
    lookups,
    infos,
    warnings,
  }
}

/** A state whose last three steps each issued one concurrency-safe call. */
const firingState: SentinelState = {
  ...init(),
  turn: 1,
  stepIndex: 4,
  steps: [
    { turn: 1, step: 1, names: ['read'] },
    { turn: 1, step: 2, names: ['read'] },
    { turn: 1, step: 3, names: ['read'] },
  ],
}

describe('context contribution', () => {
  it('registers the projection unit and one named contribution per plugin load', async () => {
    const h = await harness()
    expect(h.contribution().name).toBe(CTX_NAME)
    expect(h.contribution().order).toBe(130)
    await h.ctx.fiber.dispose()
  })

  it('contributes nothing for a bare assembly with no agent', async () => {
    const h = await harness()
    expect(h.contribute({})).toBe('')
    await h.ctx.fiber.dispose()
  })

  it('contributes nothing while the log holds no tool call', async () => {
    const h = await harness()
    expect(h.contribute({ agent: h.agent })).toBe('')
    expect(h.infos).toEqual([])
    await h.ctx.fiber.dispose()
  })

  it('contributes the decision and logs it once per observation', async () => {
    const h = await harness()
    h.setTool(tool('read', () => true))
    h.setState(firingState)
    const assembly = { agent: h.agent }

    const text = h.contribute(assembly)
    expect(text).toContain('these 3 steps each issued exactly one tool call')
    expect(h.infos).toHaveLength(1)
    expect(h.infos[0]).toContain('advising "split" at turn 1 step 4')

    // A second assembly inside the same step re-decides but must not re-log.
    expect(h.contribute(assembly)).toBe(text)
    expect(h.infos).toHaveLength(1)

    // A later step is a new observation and logs again.
    h.setState({
      ...firingState,
      stepIndex: 7,
      steps: [
        { turn: 1, step: 4, names: ['read'] },
        { turn: 1, step: 5, names: ['read'] },
        { turn: 1, step: 6, names: ['read'] },
      ],
    })
    expect(h.contribute(assembly)).toContain('step 4–6')
    expect(h.infos).toHaveLength(2)
    await h.ctx.fiber.dispose()
  })

  it('records the would-be decision and contributes nothing in observe-only mode', async () => {
    const h = await harness({ observeOnly: true })
    h.setTool(tool('read', () => true))
    h.setState(firingState)
    expect(h.contribute({ agent: h.agent })).toBe('')
    expect(h.infos.join('\n')).toContain('observe-only, nothing contributed')
    await h.ctx.fiber.dispose()
  })

  it('contains a projection read failure instead of breaking prompt assembly', async () => {
    const h = await harness()
    h.setState(() => { throw new Error('registry exploded') })
    expect(h.contribute({ agent: h.agent })).toBe('')
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain('decision failed: Error: registry exploded')
    await h.ctx.fiber.dispose()
  })

  it('classifies each distinct tool name once through its visible definition', async () => {
    const h = await harness()
    const classify = vi.fn(() => true)
    h.setTool(tool('read', classify))
    h.setState(firingState)
    h.contribute({ agent: h.agent })

    // One lookup resolves the transport's visibility, one classifies the repeated
    // name: three occurrences of `read` must not reach the definition three times.
    expect(h.lookups.map(lookup => lookup.name)).toEqual(['run_code', 'read'])
    expect(h.lookups.every(lookup => lookup.agent === h.agent)).toBe(true)
    expect(classify).toHaveBeenCalledTimes(1)
    expect(classify).toHaveBeenCalledWith({})
    await h.ctx.fiber.dispose()
  })

  it('treats an invisible, unclassifiable, refusing, or throwing tool as exclusive', async () => {
    const h = await harness()
    h.setState(firingState)
    const assembly = { agent: h.agent }

    expect(h.contribute(assembly), 'no visible definition').toBe('')
    h.setTool(tool('read'))
    expect(h.contribute(assembly), 'no classifier').toBe('')
    h.setTool(tool('read', () => false))
    expect(h.contribute(assembly), 'a refusing classifier').toBe('')
    h.setTool(tool('read', () => { throw new Error('classifier exploded') }))
    expect(h.contribute(assembly), 'a throwing classifier').toBe('')
    expect(h.warnings, 'classification failures stay out of the log').toEqual([])
    await h.ctx.fiber.dispose()
  })
})
