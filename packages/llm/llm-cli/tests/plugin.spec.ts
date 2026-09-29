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

/**
 * The route catalog once the load-time probe has landed. The probe is what
 * makes a CLI model selectable, so the wait itself is the behavior: a catalog
 * that never receives the listing leaves the picker empty.
 * @param ctx - the booted composition.
 * @returns the advertised model ids.
 */
async function advertisedIds(ctx: Context): Promise<string[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ids = (await ctx.llm.listModels(PROVIDER)).map(model => model.id)
    if (ids.includes('local:house')) return ids
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  throw new Error('llm-cli: the CLI listing never reached the route catalog')
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

  it('advertises the models the CLI lists beside the configured catalog', async () => {
    const { ctx } = await boot({ config: { ...FAKE_CLI, models: [{ id: 'house' }, { id: 'named', name: 'Named' }] } })

    // The picker reads this list, so the CLI's own ids lead it and a declared
    // entry the CLI does not report follows with its label intact.
    expect(await advertisedIds(ctx)).toEqual(['gpt-5.6-sol', 'local:house', 'house', 'named'])
  })

  it('keeps the configured catalog when the CLI cannot be asked', async () => {
    const { ctx } = await boot({ config: { command: 'definitely-not-a-real-cli', models: [{ id: 'house' }] } })

    // A deployment that ships no CLI still gets its own ids, and the probe that
    // found nothing is not a plugin failure.
    await ctx.fiber.await()
    expect((await ctx.llm.listModels(PROVIDER)).map(model => model.id)).toEqual(['house'])
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

describe('llm-cli ACP transport', () => {
  /** The ACP agent stand-in: one process, one session per conversation. */
  const FAKE_ACP_CLI: Options = {
    command: process.execPath,
    acpArgs: [fileURLToPath(new URL('./fixtures/fake-acp-cli.mjs', import.meta.url))],
    modelDiscoveryArgs: [FAKE_CLI_PATH, '--help'],
    transport: 'acp',
  }

  /** Run one request through the real route and return its raw chunks. */
  async function chunksOf(ctx: Context, extra: Partial<GenerateOptions> = {}): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: PROVIDER,
      model: 'gpt-5.6-sol',
      messages: [user('hi')],
      ...extra,
    })) chunks.push(chunk)
    return chunks
  }

  it('answers a call as streamed updates from a long-lived child', async () => {
    const { ctx } = await boot({ config: FAKE_ACP_CLI })

    // The CLI's thinking arrives as its own block, and its answer text follows
    // as the next one; neither waits for the turn to end.
    expect(await chunksOf(ctx, { sessionId: 'known' as NonNullable<GenerateOptions['sessionId']> })).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'call:1 session-1 ' },
      { type: 'text-delta', index: 1, text: 'hi' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'call:1 session-1 hi' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('serves the next call of the same conversation from that child and session', async () => {
    const { ctx } = await boot({ config: FAKE_ACP_CLI })
    const sessionId = 'known' as NonNullable<GenerateOptions['sessionId']>
    await chunksOf(ctx, { sessionId })

    // The stand-in numbers both the calls it serves and the sessions it opened:
    // a fresh child would answer `call:1` again, and a fresh session would say
    // `session-2`, so this is what proves the process and its session lasted.
    const text = (await chunksOf(ctx, { sessionId }))
      .filter(chunk => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
    expect(text).toBe('call:2 session-1 hi')
  })

  it('gives every stateless call its own session', async () => {
    const { ctx } = await boot({ config: FAKE_ACP_CLI })

    // Session titles and compaction carry no conversation, so sharing one
    // session would hand the second call the first call's history. A stateless
    // call sends the whole conversation, which is the flattened form.
    const deltas = async (): Promise<string> => (await chunksOf(ctx))
      .filter(chunk => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
    expect(await deltas()).toBe('call:1 session-1 User: hi')
    expect(await deltas()).toBe('call:2 session-2 User: hi')
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
