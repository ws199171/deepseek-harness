/**
 * The plugin entry in a real composition: the live LLM registry, the local
 * subprocess provider, and — where asserted — the settings and session seams.
 * The CLI itself is a Node one-liner, so the whole path from
 * `ctx.llm.stream()` to a child's stdout runs for real without CodeBuddy
 * installed.
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as LlmCli from '../src/index.ts'
import type { Options } from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'

/** The single provider route the plugin owns. */
const PROVIDER = 'codebuddy-cli'

/** The delegated CLI stand-in: answers with its own working directory. */
const FAKE_CLI_PATH = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url))

/** Its two invocations: a conversation, and the `--help` listing discovery asks for. */
const FAKE_CLI: Options = {
  command: process.execPath,
  args: [FAKE_CLI_PATH],
  modelDiscoveryArgs: [FAKE_CLI_PATH, '--help'],
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

interface BootOptions {
  config?: Options
  /** Mount a session store whose only known session owns a real temporary workspace. */
  sessions?: boolean
}

/** Mount the route over the real registry and subprocess provider. */
async function boot(options: BootOptions = {}) {
  const ctx = new Context()
  ctx.provide('settings', { configure: () => () => {} } as never)
  let sessionCwd: string | undefined
  if (options.sessions === true) {
    // A real directory: the child is genuinely spawned in it, so a wrong
    // resolution fails the run rather than passing unnoticed.
    sessionCwd = await mkdtemp(join(tmpdir(), 'dsh-llm-cli-session-'))
    cleanups.push(async () => { await rm(sessionCwd!, { recursive: true, force: true }) })
    ctx.provide('sessions', {
      get: (id: string) => (id === 'known' ? { header: { cwd: sessionCwd } } : undefined),
    } as never)
  }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = await ctx.plugin(LlmCli, options.config ?? FAKE_CLI)
  await ctx.fiber.await()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  return { ctx, fiber, sessionCwd }
}

/** A human-authored user message. */
function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Run one request through the real route and return the assembled answer text. */
async function answer(ctx: Context, extra: Partial<GenerateOptions> = {}): Promise<string> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({
    provider: PROVIDER,
    model: 'gpt-5.6-sol',
    messages: [user('hi')],
    ...extra,
  })) assembler.push(chunk)
  const message = assembler.message({
    provider: PROVIDER,
    model: 'gpt-5.6-sol',
    ...(assembler.replayState === undefined ? {} : { replayState: assembler.replayState }),
  })
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** The route's directory entry, as a configuration surface reads it. */
function entryOf(ctx: Context) {
  return ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === PROVIDER)
}

describe('llm-cli settings presentation', () => {
  it('claims the Models page for this entry and releases it on disposal', async () => {
    // A CLI route has no endpoint to name, so its own form would be empty: the
    // Models page owns the presentation instead of an auto-generated form.
    await omitsGeneratedPage(async (ctx) => {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      return ctx.plugin(LlmCli, FAKE_CLI)
    })
  })
})

describe('llm-cli registration', () => {
  it('registers one route, its directory entry, and its namespace discovery', async () => {
    const { ctx } = await boot()

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual([PROVIDER])
    // A loader-less mount names the namespace after the plugin itself.
    expect(entryOf(ctx)).toMatchObject({
      provider: PROVIDER,
      displayName: 'CodeBuddy CLI',
      settingsNs: 'llm-cli',
      settingsPath: [],
    })
  })

  it('takes its namespace from the loader entry id when one mounts it', async () => {
    const ctx = new Context()
    ctx.provide('settings', { configure: () => () => {} } as never)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const observation = await liveConfig(ctx, LlmCli, FAKE_CLI)
    cleanups.push(async () => { await ctx.fiber.dispose() })

    // The Models page already holds this id from the configurable-provider
    // directory, so discovery has to be offered under exactly that name.
    const settingsNs = observation.entry.options.id
    expect(entryOf(ctx)?.settingsNs).toBe(settingsNs)
    await expect(ctx.llm.discoverModels(settingsNs, { provider: PROVIDER })).resolves.toEqual([
      { id: 'gpt-5.6-sol' },
      { id: 'local:house' },
    ])
  })

  it('advertises the configured catalog through the registered adapter', async () => {
    const { ctx } = await boot({ config: { ...FAKE_CLI, models: [{ id: 'house' }, { id: 'named', name: 'Named' }] } })

    expect((await ctx.llm.listModels(PROVIDER)).map(model => model.id)).toEqual(['house', 'named'])
  })

  it('withdraws the route and its discovery offer when the plugin unloads', async () => {
    const { ctx, fiber } = await boot()
    expect(ctx.llm.listProviders()).toHaveLength(1)

    await fiber.dispose()

    expect(ctx.llm.listProviders()).toEqual([])
    await expect(ctx.llm.discoverModels('llm-cli', { provider: PROVIDER })).rejects.toMatchObject({ code: 'NO_DISCOVERY' })
  })
})

describe('llm-cli discovery', () => {
  it('interrogates the configured CLI through the shared subprocess seam', async () => {
    const { ctx } = await boot()

    expect(await ctx.llm.discoverModels('llm-cli', { provider: PROVIDER })).toEqual([
      { id: 'gpt-5.6-sol' },
      { id: 'local:house' },
    ])
  })

  it('offers the configured catalog after the ids the CLI reports, and alone when it cannot report', async () => {
    const listed = await boot({ config: { ...FAKE_CLI, models: [{ id: 'house', name: 'House' }] } })
    expect(await listed.ctx.llm.discoverModels('llm-cli', { provider: PROVIDER }))
      .toEqual([{ id: 'gpt-5.6-sol' }, { id: 'local:house' }, { id: 'house', name: 'House' }])

    // An unstartable executable is not a plugin failure: the route's own
    // catalog is the answer a deployment that ships no CLI still gets.
    const missing = await boot({ config: { command: 'definitely-not-a-real-cli', models: [{ id: 'house' }] } })
    expect(await missing.ctx.llm.discoverModels('llm-cli', { provider: PROVIDER })).toEqual([{ id: 'house' }])
  })
})

describe('llm-cli conversation', () => {
  it('answers a model call through a real CLI child and reports its usage', async () => {
    const { ctx } = await boot()
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: PROVIDER,
      model: 'gpt-5.6-sol',
      messages: [user('hi')],
    })) chunks.push(chunk)

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: process.cwd() },
      { type: 'block-end', index: 0, block: { type: 'text', text: process.cwd() } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('runs a persistent session in the workspace the session store resolves', async () => {
    const { ctx, sessionCwd } = await boot({ sessions: true })

    // The child reports the resolved path, which on a macOS temp directory is
    // the /private spelling of the symlinked one the store holds.
    expect(await answer(ctx, { sessionId: 'known' as NonNullable<GenerateOptions['sessionId']> }))
      .toBe(await realpath(sessionCwd!))
  })

  it('falls back to the configured workspace when the session records none or the store has no such session', async () => {
    const { ctx } = await boot({ sessions: true })

    // A session the store does not know, and a composition with no store at
    // all, both run in the process workspace rather than failing.
    expect(await answer(ctx, { sessionId: 'unknown' as NonNullable<GenerateOptions['sessionId']> })).toBe(process.cwd())

    const headless = await boot()
    expect(await answer(headless.ctx, { sessionId: 'known' as NonNullable<GenerateOptions['sessionId']> }))
      .toBe(process.cwd())
  })

  it('reports an unstartable CLI as a request failure rather than throwing', async () => {
    const { ctx } = await boot({ config: { command: 'definitely-not-a-real-cli', args: [] } })
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: PROVIDER,
      model: 'gpt-5.6-sol',
      messages: [user('hi')],
    })) chunks.push(chunk)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  })
})

describe('llm-cli configuration validation', () => {
  it('judges a settings write where it lands', async () => {
    const { fiber } = await boot()
    // The loader runs this waterfall on the entry's own fiber before it commits
    // a snapshot, which is the shape a write actually takes.
    const write = (raw: unknown): unknown => fiber.ctx.waterfall(fiber, 'internal/config', raw, () => raw)

    expect(write({ command: process.execPath })).toEqual({ command: process.execPath })
    // Beyond the schema: a blank command would shift the prompt to argv[1].
    expect(() => write({ command: '   ' })).toThrow(/command must be non-empty/)
    // An unusable grace period is refused at the same boundary, whether the
    // schema or the resolve step is what names it.
    expect(() => write({ disposeGraceMs: 0 })).toThrow(/disposeGraceMs/)
    expect(() => write({ permissionMode: 'accept-everything' })).toThrow()
  })

  it('leaves a descendant fiber\'s own configuration to its owner', async () => {
    const { fiber } = await boot()
    const child = await fiber.ctx.plugin({ name: 'llm-cli-probe', apply: () => {} })

    // The listener is scoped to the route's own entry, so a nested plugin's
    // config is never judged by this route's rules. The waterfall is untyped at
    // this seam, so the returned value is read back as the raw pass-through.
    expect(() => { child.ctx.waterfall(child, 'internal/config', { command: '   ' }, () => 'inner') }).not.toThrow()
    const raw: unknown = child.ctx.waterfall(child, 'internal/config', { command: '   ' }, () => 'inner')
    expect(raw).toBe('inner')
  })
})
