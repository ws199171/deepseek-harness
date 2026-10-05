/**
 * Provider-level behavior for the branches a live loop cannot reach: a bare
 * assembly with no agent, a registry that has no unit for this key, a repeated
 * identical observation, and a registry that throws.
 *
 * The loop-driven suite in `sentinel.spec.ts` is the evidence that the sentinel
 * works end to end; this suite exists because those four branches are about the
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
  setStateOf: (impl: (session: Session) => SentinelState | undefined) => void
  /** Every classification probe input, in call order. */
  probes: { callId: string; name: string; arguments: unknown; agent: unknown; signal: unknown }[]
  infos: string[]
  warnings: string[]
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

  let stateOfImpl: (session: Session) => SentinelState | undefined = () => undefined
  let captured: PromptContext | undefined
  const infos: string[] = []
  const warnings: string[] = []
  const probes: Harness['probes'] = []

  ctx.provide('sessionProjections', {
    register: () => () => {},
    stateOf: (_session: Session, _key: string) => stateOfImpl(_session),
  })
  ctx.provide('systemPrompt', {
    context: (contribution: PromptContext) => {
      captured = contribution
      return () => {}
    },
  })
  ctx.provide('tools', {
    get: () => undefined,
    executionMode: (input: Harness['probes'][number]) => {
      probes.push(input)
      return { kind: 'parallel' as const }
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
    setStateOf: (impl) => { stateOfImpl = impl },
    probes,
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

  it('contributes nothing while the registry has no unit for this key', async () => {
    const h = await harness()
    h.setStateOf(() => undefined)
    expect(h.contribute({ agent: h.agent })).toBe('')
    expect(h.infos).toEqual([])
    await h.ctx.fiber.dispose()
  })

  it('contributes the decision and logs it once per observation', async () => {
    const h = await harness()
    h.setStateOf(() => firingState)
    const assembly = { agent: h.agent }

    const text = h.contribute(assembly)
    expect(text).toContain('these 3 steps each issued exactly one tool call')
    expect(h.infos).toHaveLength(1)
    expect(h.infos[0]).toContain('advising "split" at turn 1 step 4')

    // A second assembly inside the same step re-decides but must not re-log.
    expect(h.contribute(assembly)).toBe(text)
    expect(h.infos).toHaveLength(1)

    // A later step is a new observation and logs again.
    h.setStateOf(() => ({
      ...firingState,
      stepIndex: 7,
      steps: [
        { turn: 1, step: 4, names: ['read'] },
        { turn: 1, step: 5, names: ['read'] },
        { turn: 1, step: 6, names: ['read'] },
      ],
    }))
    expect(h.contribute(assembly)).toContain('step 4–6')
    expect(h.infos).toHaveLength(2)
    await h.ctx.fiber.dispose()
  })

  it('records the would-be decision and contributes nothing in observe-only mode', async () => {
    const h = await harness({ observeOnly: true })
    h.setStateOf(() => firingState)
    expect(h.contribute({ agent: h.agent })).toBe('')
    expect(h.infos.join('\n')).toContain('observe-only, nothing contributed')
    await h.ctx.fiber.dispose()
  })

  it('contains a registry failure instead of breaking prompt assembly', async () => {
    const h = await harness()
    h.setStateOf(() => { throw new Error('registry exploded') })
    expect(h.contribute({ agent: h.agent })).toBe('')
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain('decision failed: Error: registry exploded')
    await h.ctx.fiber.dispose()
  })

  it('probes classification once per distinct tool name with an argument-free input', async () => {
    const h = await harness()
    h.setStateOf(() => firingState)
    h.contribute({ agent: h.agent })

    expect(h.probes.map(probe => probe.name), 'one probe for a repeated name').toEqual(['read'])
    const probe = h.probes[0]
    expect(probe?.arguments).toEqual({})
    expect(probe?.agent).toBe(h.agent)
    expect(probe?.signal).toBeInstanceOf(AbortSignal)
    expect(typeof probe?.callId).toBe('string')
    await h.ctx.fiber.dispose()
  })
})
