/**
 * Real Loader composition: the plugin is activated the way a deployment
 * activates it — through a `cordis.yml` read by the Loader, with the real
 * session, system-prompt, tools and projection services — and the assertion is
 * the assembled model-visible snapshot rather than an internal call.
 * @module @deepseek-ai/dsh-orchestration-sentinel/tests/loader-composition
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

import * as sessionPlugin from '@deepseek-ai/dsh-session'
import * as systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as toolsPlugin from '@deepseek-ai/dsh-tools'
import * as projectionPlugin from '@deepseek-ai/dsh-session-projection'
import * as sentinelPlugin from '../src/index.ts'

let context: Context | undefined
let root: string | undefined
/**
 * The importer this spec replaced. `ctx.loader.internal` is Node's own module
 * loader, so leaving a stub in place would leak into every later import in the
 * worker; restoring it keeps the mutation inside this file.
 */
let restoreImport: (() => void) | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  restoreImport?.()
  restoreImport = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a temporary profile whose fixture composition includes the plugin.
 * @param sentinelConfig - YAML for the plugin's own `config` row.
 * @returns the activated context.
 */
async function boot(sentinelConfig: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'sentinel-loader-'))
  const fixture = await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, fixture.replace('{{SENTINEL_CONFIG}}', sentinelConfig))

  const ctx = context = new Context()
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', sessionPlugin],
    ['@deepseek-ai/dsh-system-prompt', systemPromptPlugin],
    ['@deepseek-ai/dsh-tools', toolsPlugin],
    ['@deepseek-ai/dsh-session-projection', projectionPlugin],
    ['@deepseek-ai/dsh-orchestration-sentinel', sentinelPlugin],
  ])
  const internal = ctx.loader.internal
  if (internal === undefined) throw new Error('the test environment exposes no internal module loader')
  // A direct assignment rather than the `as unknown as` cast older suites use:
  // the real method type already accepts a shorter async importer.
  const original = internal.import
  internal.import = async (specifier: string) => {
    if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
    return modules.get(specifier)
  }
  restoreImport = () => { internal.import = original }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  // After composition: a deployment's tools arrive through their own plugins,
  // and the sentinel's judgement is about them, so the fixture supplies the
  // concurrency-safe one it reasons over.
  ctx.tools.register(defineContentToolFixture({
    name: 'read',
    description: 'read',
    parameters: {},
    isConcurrencySafe: () => true,
    async execute() { return [{ type: 'text' as const, text: 'ok' }] },
  }))
  return ctx
}

/**
 * A session whose first three steps each issued exactly one concurrency-safe
 * call, with a fourth step opened — the moment a batching reminder is due.
 * @param ctx - the activated context.
 * @returns an agent over that session.
 */
function preparedAgent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId('sentinel-composition'))
  session.append('turn/start', { turn: 1 })
  for (let step = 1; step <= 4; step += 1) {
    session.append('step/start', { turn: 1, step })
    if (step === 4) break
    session.append('tool/call', {
      turn: 1,
      step,
      callId: ToolCallId(`c${step}`),
      name: 'read',
      arguments: '{"path":"a.ts"}',
    })
  }
  return { id: session.id, ctx, session } as Agent
}

describe('orchestration sentinel real Loader composition', () => {
  it('activates through the Loader and contributes its decision to the assembled snapshot', async () => {
    const ctx = await boot('{}')
    const agent = preparedAgent(ctx)
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, new AbortController().signal))

    const snapshot = renderContextSnapshot(assembly)
    expect(snapshot).toContain('these 3 steps each issued exactly one tool call')
    expect(snapshot).toContain('turn 1, step 1–3')
    expect(assembly.contexts.map(contribution => contribution.name)).toContain('orchestration:sentinel')
  })

  it('contributes nothing when the deployment configures observe-only', async () => {
    const ctx = await boot('{ observeOnly: true }')
    const agent = preparedAgent(ctx)
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, new AbortController().signal))

    expect(renderContextSnapshot(assembly)).not.toContain('these 3 steps')
  })

  // Activation-time rejection of an out-of-range value belongs to the profile
  // boot path, which applies each plugin's Config; the Loader itself mounts the
  // parsed row unchanged. The schema's own rejections are asserted directly in
  // `state.spec.ts` rather than re-asserted through a harness that would only be
  // testing the platform.
})
