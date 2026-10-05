import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { type PromptContext } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BUDGET_PROFILES } from '../src/budget.ts'
import { CONTEXT_NAME } from '../src/identity.ts'
import { apply, inject, name } from '../src/index.ts'
import { createStore } from '../src/store.ts'
import { nodeFileSystem, type TestFileSystem } from './helpers/node-fs-provider.ts'

let scratch = ''

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'context-ledger-plugin-'))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/**
 * Create an isolated ledger home and project for one test.
 *
 * Cases must not share either: entries accumulate in a home, so a shared one
 * would make each test's catalog depend on which tests ran before it.
 *
 * @returns The isolated paths.
 */
async function freshCase(): Promise<{ home: string; project: string }> {
  const caseDir = await mkdtemp(join(scratch, 'case-'))
  const project = join(caseDir, 'demo')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'package.json'), '{"name":"fixture"}\n')
  return { home: join(caseDir, 'home'), project }
}

/**
 * Create a directory carrying no project marker.
 *
 * @returns The absolute path.
 */
async function freshPlainDir(): Promise<string> {
  return mkdtemp(join(scratch, 'plain-'))
}

/**
 * Open a store over the same home and project the plugin was configured with.
 *
 * @param paths - The case paths.
 * @returns The store handle.
 */
function storeFor(paths: { home: string; project: string }) {
  return createStore({ home: paths.home, projectRoot: paths.project })
}

/** What a fixture exposes. */
interface Fixture {
  readonly ctx: Context
  readonly contexts: PromptContext[]
  readonly injected: Array<{ content: Array<{ text: string }>; source: { kind: string } }>
  readonly warnings: unknown[][]
  /** The block the agent's registered provider would contribute. */
  readonly blockOf: (agent: unknown) => string
  readonly emit: (event: string, payload: unknown, second?: unknown) => Promise<void>
}

/**
 * Mount the plugin on a real Context and capture what it registers.
 *
 * @param request - The fixture request.
 * @param request.paths - The ledger home and project for this case.
 * @param request.fs - The filesystem provider to compose; `undefined` composes none.
 * @param request.services - Optional service stubs to provide before the plugin loads.
 * @param request.config - Config overrides.
 * @returns The fixture.
 */
async function fixture(request: {
  paths?: { home: string; project: string }
  fs?: TestFileSystem | undefined
  services?: Record<string, unknown>
  config?: Record<string, unknown>
} = {}): Promise<Fixture> {
  const paths = request.paths ?? await freshCase()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  const fs = 'fs' in request ? request.fs : nodeFileSystem()
  if (fs !== undefined) ctx.provide('fs', fs as never)
  for (const [service, value] of Object.entries(request.services ?? {})) {
    ctx.provide(service as never, value as never)
  }

  const contexts: PromptContext[] = []
  vi.spyOn(ctx.systemPrompt, 'context').mockImplementation((spec) => {
    contexts.push(spec)
    return () => {
      const index = contexts.indexOf(spec)
      if (index >= 0) contexts.splice(index, 1)
    }
  })

  const warnings: unknown[][] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args)
  })

  const injected: Fixture['injected'] = []
  apply(ctx, { ledgerHome: paths.home, ...request.config })

  const blockOf = (agent: unknown): string => {
    const spec = contexts.at(-1)
    if (spec === undefined) throw new Error('no runtime context was registered')
    if (typeof spec.text === 'string') return spec.text
    // `AssembleContext` carries the agent under the merge `dsh-agent` declares.
    return spec.text(agent === undefined ? {} : { agent: agent as never })
  }

  return {
    ctx,
    contexts,
    injected,
    warnings,
    blockOf,
    async emit(event, payload, second) {
      // `parallel` is typed per event name; the fixture drives several names, so
      // it takes the call through one widened reference.
      const parallel = ctx.parallel.bind(ctx) as never as (event: string, payload: unknown, second?: unknown) => Promise<void>
      await parallel(event, payload, second)
    },
  }
}

/** One stub agent whose session reports a working directory. */
interface StubAgent {
  readonly session: {
    readonly id: string
    readonly header: { readonly cwd: string }
    readonly requestHeader: () => { config: { provider: string; model: string } } | undefined
  }
  readonly ctx: Context
  readonly inject: (message: Fixture['injected'][number]) => void
}

/**
 * Build an agent stub whose scoped context is the real one.
 *
 * @param ctx - The harness context, used as the agent's scoped context.
 * @param cwd - The session working directory.
 * @param request - The stub request.
 * @param request.route - Routed model, when the session should report one.
 * @returns The agent.
 */
function stubAgent(ctx: Context, cwd: string, request: { route?: { provider: string; model: string } } = {}): StubAgent {
  return {
    session: {
      id: 'session-under-test',
      header: { cwd },
      requestHeader: () => (request.route === undefined ? undefined : { config: request.route }),
    },
    ctx,
    inject: () => {},
  }
}

/**
 * Await a condition a background refresh will make true.
 *
 * @param predicate - The condition.
 * @returns Whether it became true before the deadline.
 */
async function waitFor(predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return false
}

/**
 * Await an asynchronous condition, for writes a background task performs.
 *
 * @param predicate - The condition.
 * @returns Whether it became true before the deadline.
 */
async function waitForAsync(predicate: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return false
}

/** A log with one turn, one tool call, one compaction, and a completed ending. */
function sampleEvents() {
  return [
    { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1_050, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 2, time: 1_100, data: { name: 'read', arguments: '{"file_path":"a.ts"}' } },
    { type: 'compaction/start', seq: 3, time: 1_150, data: { compactionId: 'c1' } },
    { type: 'turn/end', seq: 4, time: 1_200, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/**
 * Announce a created agent and return its block reader.
 *
 * @param f - The fixture.
 * @param cwd - The session working directory.
 * @param request - The stub request.
 * @returns The agent and a reader for its current block.
 */
async function createAgent(
  f: Fixture,
  cwd: string,
  request: { route?: { provider: string; model: string } } = {},
): Promise<{ agent: StubAgent; block: () => string }> {
  const agent = stubAgent(f.ctx, cwd, request)
  await f.emit('agent/created', { agent }, undefined)
  return { agent, block: () => f.blockOf(agent) }
}

/**
 * Run one registered ledger tool through the registry, as the model would.
 *
 * @param f - The fixture.
 * @param agent - The calling agent.
 * @param toolName - The tool to run.
 * @param args - Tool arguments.
 * @returns The result value.
 */
async function runTool(f: Fixture, agent: StubAgent, toolName: string, args: unknown): Promise<unknown> {
  const result = await f.ctx.tools.execute({
    name: toolName,
    arguments: args,
    callId: 'call-1' as never,
    signal: new AbortController().signal,
    agent: agent as never,
  })
  // The registry reports a thrown tool error as an error result rather than a
  // rejection; re-raise it so callers keep asserting on the model-visible failure.
  if (result.isError) {
    throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
  }
  return result.value
}

/**
 * Announce a successful tool result for one file path.
 *
 * @param f - The fixture.
 * @param agent - The calling agent.
 * @param toolName - The tool name.
 * @param args - Tool arguments.
 * @returns Nothing.
 */
async function touch(f: Fixture, agent: StubAgent, toolName: string, args: unknown): Promise<void> {
  await f.emit('tools/result', {
    name: toolName,
    agent,
    arguments: args,
    signal: new AbortController().signal,
  }, { isError: false })
}

describe('the loader contract', () => {
  it('declares name and required services', () => {
    expect(name).toBe('dsh-context-ledger')
    expect(inject).toEqual(['systemPrompt', 'tools'])
  })

  it('throws at apply rather than at assembly for an unusable configuration', async () => {
    const paths = await freshCase()
    for (const config of [
      { projectRootMarkers: [] },
      { contextOrder: Number.NaN },
      { budgetProfile: 'generous' },
      { budgetOverrides: { maxIndexEntries: -1 } },
    ]) {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      expect(() => { apply(ctx, { ledgerHome: paths.home, ...config } as never) }).toThrow()
    }
  })
})

describe('the injected block', () => {
  it('registers one provider whose text is the project block', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    const { block } = await createAgent(f, paths.project)

    expect(f.contexts).toHaveLength(1)
    expect(f.contexts[0]?.name).toBe(CONTEXT_NAME)
    expect(f.contexts[0]?.order).toBe(100)
    expect(block()).toBe([
      '<project_context>',
      `Project: ${basename(paths.project)}`,
      `Root: ${paths.project}`,
      'Stack: package.json',
      '</project_context>',
    ].join('\n'))
  })

  it('counts an unconfirmed fact but never injects it', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    const { agent, block } = await createAgent(f, paths.project)
    expect(block()).not.toContain('Memory:')

    await runTool(f, agent, 'ledger_write', { kind: 'build', title: 'A durable fact', body: 'body' })

    expect(await waitFor(() => block().includes('Memory: 1 recorded, 0 shown'))).toBe(true)
    expect(block()).not.toContain('- [build] A durable fact')
  })

  it('lets a confirmed fact reach the block', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    const { agent, block } = await createAgent(f, paths.project)

    const written = await runTool(f, agent, 'ledger_write', {
      kind: 'build', title: 'Run the suite with pnpm test', body: 'pnpm test',
    }) as { id: string }
    expect(await waitFor(() => block().includes('0 shown'))).toBe(true)

    // Promote through the store: this fixture composes no approval surface, so the
    // tool path is covered by the tools suite instead.
    const store = storeFor(paths)
    const stored = await store.get(written.id)
    if (!stored.ok) throw new Error(stored.reason)
    await store.put({ ...stored.entry, tier: 'confirmed' })

    await f.emit('session/event', agent.session, { type: 'turn/start' })

    expect(await waitFor(() => block().includes('- [build] Run the suite with pnpm test'))).toBe(true)
    expect(block()).toContain('Memory: 1 recorded, 1 shown')
  })

  it('contributes nothing for a directory without a marker', async () => {
    const plain = await freshPlainDir()
    const f = await fixture()
    const { block } = await createAgent(f, plain)
    expect(block()).toBe('')
  })

  it('contributes nothing without a filesystem provider instead of failing', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths, fs: undefined })
    const { block } = await createAgent(f, paths.project)
    expect(f.contexts).toHaveLength(1)
    expect(block()).toBe('')
    expect(f.warnings).toEqual([])
  })

  it('contributes nothing without an agent in the assembly context', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    await createAgent(f, paths.project)
    expect(f.blockOf(undefined)).toBe('')
  })

  it('logs a read failure during preload and never throws at the loader', async () => {
    const paths = await freshCase()
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const failing: TestFileSystem = {
      async resolve(path) { return path },
      async stat() { throw denied },
      async readText() { throw denied },
    }
    const f = await fixture({ paths, fs: failing })

    // A throw here would roll back agent creation, so the listener must absorb it.
    const { block } = await createAgent(f, paths.project)

    expect(block()).toBe('')
    expect(f.warnings).toHaveLength(1)
  })

  it('removes its scoped registration when the agent is disposed', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    const { agent } = await createAgent(f, paths.project)
    expect(f.contexts).toHaveLength(1)

    await f.emit('agent/disposed', { agent }, undefined)

    expect(f.contexts).toHaveLength(0)
  })

  it('reports why a ledger tool outside a project cannot run', async () => {
    const plain = await freshPlainDir()
    const f = await fixture()
    const { agent } = await createAgent(f, plain)

    await expect(runTool(f, agent, 'ledger_read', { id: 'anything' }))
      .rejects.toThrow(/not inside a detected project/u)
  })
})

describe('archiving', () => {
  it('archives a disposed session from its log, after that log is flushed', async () => {
    const paths = await freshCase()
    const order: string[] = []
    const f = await fixture({
      paths,
      services: {
        sessions: { async flush() { order.push('flush') } },
        sessionQuery: {
          async readSession() {
            order.push('read')
            return { events: sampleEvents() }
          },
        },
      },
    })
    const { agent } = await createAgent(f, paths.project)

    await f.emit('agent/disposed', { agent }, undefined)

    const store = storeFor(paths)
    expect(await waitForAsync(async () => (await store.listArchive()).rows.length === 1)).toBe(true)
    const { rows } = await store.listArchive()
    const row = rows[0]
    expect(row?.sessionId).toBe(agent.session.id)
    expect(row?.turns).toBe(1)
    expect(row?.toolCalls).toBe(1)
    expect(row?.compactions).toBe(1)
    expect(row?.elapsedMs).toBe(200)
    expect(row?.lastTurnReason).toBe('completed')
    expect([...(row?.pathsTouched ?? [])]).toEqual(['a.ts'])
    // Reading before the flush would archive a row that silently misses the tail.
    expect(order).toEqual(['flush', 'read'])
  })

  it('replaces the row when a resumed session is archived again', async () => {
    const paths = await freshCase()
    let events = sampleEvents()
    const f = await fixture({
      paths,
      services: {
        sessions: { async flush() {} },
        sessionQuery: { async readSession() { return { events } } },
      },
    })
    const { agent } = await createAgent(f, paths.project)
    await f.emit('agent/disposed', { agent }, undefined)
    const store = storeFor(paths)
    expect(await waitForAsync(async () => (await store.listArchive()).rows.length === 1)).toBe(true)

    events = [...events, { type: 'turn/start', seq: 5, time: 1_300, data: { turn: 2 } }]
    await f.emit('agent/disposed', { agent }, undefined)

    expect(await waitForAsync(async () => (await store.listArchive()).rows[0]?.turns === 2)).toBe(true)
    expect((await store.listArchive()).rows).toHaveLength(1)
  })

  it('logs an archive failure and never surfaces it as a teardown error', async () => {
    const paths = await freshCase()
    const f = await fixture({
      paths,
      services: {
        sessions: { async flush() { throw new Error('flush exploded') } },
        sessionQuery: { async readSession() { return { events: sampleEvents() } } },
      },
    })
    const { agent } = await createAgent(f, paths.project)

    await f.emit('agent/disposed', { agent }, undefined)

    expect(await waitFor(() => f.warnings.length === 1)).toBe(true)
    expect(String(f.warnings[0]?.[0])).toMatch(/could not archive/u)
    expect((await storeFor(paths).listArchive()).rows).toHaveLength(0)
  })

  it('archives nothing, quietly, without a session query', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    const { agent } = await createAgent(f, paths.project)

    await f.emit('agent/disposed', { agent }, undefined)
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(f.warnings).toEqual([])
    expect((await storeFor(paths).listArchive()).rows).toHaveLength(0)
  })

  it('does not archive a session outside any project', async () => {
    const plain = await freshPlainDir()
    const paths = await freshCase()
    const f = await fixture({
      paths,
      services: {
        sessions: { async flush() {} },
        sessionQuery: { async readSession() { return { events: sampleEvents() } } },
      },
    })
    const { agent } = await createAgent(f, plain)

    await f.emit('agent/disposed', { agent }, undefined)
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(f.warnings).toEqual([])
    expect((await storeFor(paths).listArchive()).rows).toHaveLength(0)
  })

  it('turns archiving off without losing the block', async () => {
    const paths = await freshCase()
    const f = await fixture({
      paths,
      config: { archiveEnabled: false },
      services: {
        sessions: { async flush() {} },
        sessionQuery: { async readSession() { return { events: sampleEvents() } } },
      },
    })
    const { agent } = await createAgent(f, paths.project)
    // The block is contributed as usual; only the archiving is off.
    expect(f.contexts).toHaveLength(1)

    await f.emit('agent/disposed', { agent }, undefined)
    await new Promise(resolve => setTimeout(resolve, 30))

    expect((await storeFor(paths).listArchive()).rows).toHaveLength(0)
  })
})

describe('conventions', () => {
  it('delivers them on touch, nearest first, and only once each', async () => {
    const paths = await freshCase()
    await mkdir(join(paths.project, 'src'), { recursive: true })
    await writeFile(join(paths.project, 'CONTEXT.md'), 'Root convention.\n')
    await writeFile(join(paths.project, 'src', 'CONTEXT.md'), 'Src convention.\n')
    const f = await fixture({ paths })
    const { agent } = await createAgent(f, paths.project)
    const injected = captureInjected(f, agent)
    // Progressive disclosure: nothing before a touch.
    expect(injected()).toHaveLength(0)

    await touch(f, agent, 'read', { file_path: join(paths.project, 'src', 'a.ts') })
    expect(await waitFor(() => injected().length === 1)).toBe(true)
    // A contained delivery failure would otherwise look exactly like a success
    // here, because both leave the inbox empty.
    expect(f.warnings).toEqual([])
    const text = injected()[0]?.content[0]?.text ?? ''
    expect(text).toContain('Src convention.')
    expect(text).toContain('Root convention.')
    expect(injected()[0]?.source.kind).toBe('context-ledger-conventions')
    expect(text.indexOf('Src convention.')).toBeLessThan(text.indexOf('Root convention.'))

    // A second file in the same directory has nothing new to deliver.
    await touch(f, agent, 'read', { file_path: join(paths.project, 'src', 'b.ts') })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(injected()).toHaveLength(1)
  })

  it('delivers nothing for a directory with no convention file', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    const { agent } = await createAgent(f, paths.project)
    const injected = captureInjected(f, agent)

    await touch(f, agent, 'read', { file_path: join(paths.project, 'package.json') })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(injected()).toHaveLength(0)
    expect(f.warnings).toEqual([])
  })

  it('delivers no conventions for a file outside the project', async () => {
    const paths = await freshCase()
    const elsewhere = await freshPlainDir()
    await writeFile(join(elsewhere, 'CONTEXT.md'), 'Not this project.\n')
    const f = await fixture({ paths })
    const { agent } = await createAgent(f, paths.project)
    const injected = captureInjected(f, agent)

    await touch(f, agent, 'read', { file_path: join(elsewhere, 'a.ts') })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(injected()).toHaveLength(0)
  })

  it('reports a convention over the per-file ceiling rather than dropping it', async () => {
    const paths = await freshCase()
    await writeFile(join(paths.project, 'CONTEXT.md'), 'x'.repeat(400))
    const f = await fixture({ paths, config: { budgetOverrides: { maxConventionFileBytes: 50 } } })
    const { agent } = await createAgent(f, paths.project)
    const injected = captureInjected(f, agent)

    await touch(f, agent, 'read', { file_path: join(paths.project, 'package.json') })

    expect(await waitFor(() => injected().length === 1)).toBe(true)
    expect(injected()[0]?.content[0]?.text ?? '').toMatch(/not included: 400 bytes exceeds the 50-byte ceiling/u)
  })

  it('contains a convention read failure', async () => {
    const paths = await freshCase()
    await writeFile(join(paths.project, 'CONTEXT.md'), 'Root convention.\n')
    const inner = nodeFileSystem()
    const f = await fixture({
      paths,
      fs: {
        resolve: inner.resolve,
        async stat(path, signal) {
          if (path.endsWith('CONTEXT.md')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
          return inner.stat(path, signal)
        },
        readText: inner.readText,
      },
    })
    const { agent } = await createAgent(f, paths.project)
    const injected = captureInjected(f, agent)

    await touch(f, agent, 'read', { file_path: join(paths.project, 'package.json') })

    expect(await waitFor(() => f.warnings.length === 1)).toBe(true)
    expect(String(f.warnings[0]?.[0])).toMatch(/convention delivery failed/u)
    expect(injected()).toHaveLength(0)
  })
})

/**
 * Capture what the plugin injects into one agent's inbox.
 *
 * @param f - The fixture.
 * @param agent - The agent to watch.
 * @returns A reader for the injected messages.
 */
function captureInjected(f: Fixture, agent: StubAgent): () => Fixture['injected'] {
  const messages: Fixture['injected'] = []
  Object.defineProperty(agent, 'inject', {
    value: (message: Fixture['injected'][number]) => {
      messages.push(message)
      f.injected.push(message)
    },
  })
  return () => messages
}

describe('the adaptive rung', () => {
  /**
   * Confirm one fact so the catalog has something to inject.
   *
   * @param f - The fixture.
   * @param agent - The agent.
   * @param paths - The case paths.
   * @returns Nothing.
   */
  async function confirmOneFact(f: Fixture, agent: StubAgent, paths: { home: string; project: string }): Promise<void> {
    const written = await runTool(f, agent, 'ledger_write', {
      kind: 'build', title: 'Run the suite', body: 'pnpm test',
    }) as { id: string }
    const store = storeFor(paths)
    const stored = await store.get(written.id)
    if (!stored.ok) throw new Error(stored.reason)
    await store.put({ ...stored.entry, tier: 'confirmed' })
  }

  it('takes the widest rung the window affords', async () => {
    const paths = await freshCase()
    const f = await fixture({
      paths,
      config: { budgetProfile: 'adaptive' },
      services: {
        tokenMeter: { measure: () => ({ totalTokens: 0 }) },
        llm: { async resolveModelInfo() { return { context: { contextWindow: 200_000 } } } },
      },
    })
    const { agent, block } = await createAgent(f, paths.project, { route: { provider: 'deepseek', model: 'demo' } })
    await confirmOneFact(f, agent, paths)
    await f.emit('session/event', agent.session, { type: 'turn/start' })

    expect(await waitFor(() => block().includes('- [build] Run the suite'))).toBe(true)
  })

  it('falls back to the identity-only floor when the window is full', async () => {
    const paths = await freshCase()
    const f = await fixture({
      paths,
      config: { budgetProfile: 'adaptive' },
      services: {
        tokenMeter: { measure: () => ({ totalTokens: 199_000 }) },
        llm: { async resolveModelInfo() { return { context: { contextWindow: 200_000 } } } },
      },
    })
    const { agent, block } = await createAgent(f, paths.project, { route: { provider: 'deepseek', model: 'demo' } })
    await confirmOneFact(f, agent, paths)
    await f.emit('session/event', agent.session, { type: 'turn/start' })

    expect(await waitFor(() => block().includes('Memory: 1 recorded, 0 shown'))).toBe(true)
    expect(block()).not.toContain('- [build]')
  })

  it('moves the rung at a checkpoint and not on a tool result', async () => {
    const paths = await freshCase()
    let usedTokens = 199_000
    const f = await fixture({
      paths,
      config: { budgetProfile: 'adaptive' },
      services: {
        tokenMeter: { measure: () => ({ totalTokens: usedTokens }) },
        llm: { async resolveModelInfo() { return { context: { contextWindow: 200_000 } } } },
      },
    })
    const { agent, block } = await createAgent(f, paths.project, { route: { provider: 'deepseek', model: 'demo' } })
    await confirmOneFact(f, agent, paths)
    await f.emit('session/event', agent.session, { type: 'turn/start' })
    expect(await waitFor(() => block().includes('0 shown'))).toBe(true)

    // The window frees up, but a tool result is not a checkpoint.
    usedTokens = 0
    await runTool(f, agent, 'ledger_write', { kind: 'note', title: 'A second fact', body: 'body' })
    await touch(f, agent, 'ledger_write', {})
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(block()).not.toContain('- [build] Run the suite')

    // A turn boundary is a checkpoint, so the rung widens there.
    await f.emit('session/event', agent.session, { type: 'turn/start' })
    expect(await waitFor(() => block().includes('- [build] Run the suite'))).toBe(true)
  })

  it('uses the default rung when an adaptive deployment has no measurement', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths, config: { budgetProfile: 'adaptive' } })
    const { agent, block } = await createAgent(f, paths.project)
    await confirmOneFact(f, agent, paths)
    await f.emit('session/event', agent.session, { type: 'turn/start' })

    expect(await waitFor(() => block().includes('- [build] Run the suite'))).toBe(true)
  })

  it('reports the rung the session actually took, not the configured name', async () => {
    const paths = await freshCase()
    const f = await fixture({
      paths,
      config: { budgetProfile: 'adaptive' },
      services: {
        tokenMeter: { measure: () => ({ totalTokens: 199_000 }) },
        llm: { async resolveModelInfo() { return { context: { contextWindow: 200_000 } } } },
      },
    })
    const { agent } = await createAgent(f, paths.project, { route: { provider: 'deepseek', model: 'demo' } })

    const status = await runTool(f, agent, 'ledger_status', {}) as {
      adaptive: { configured: string; rung: string; usedTokens?: number; contextWindow?: number }
      ceilings: Record<string, number>
    }

    expect(status.adaptive.configured).toBe('adaptive')
    expect(status.adaptive.rung).toBe('identity-only')
    expect(status.adaptive.usedTokens).toBe(199_000)
    expect(status.adaptive.contextWindow).toBe(200_000)
    // The ceilings reported are the rung's, so an operator can see the block shrank.
    expect(status.ceilings.maxIndexEntries).toBe(0)
    expect(status.ceilings.maxIdentityBytes).toBe(BUDGET_PROFILES.frugal.maxIdentityBytes)
  })
})

describe('teardown', () => {
  it('releases every scoped registration it kept', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    await createAgent(f, paths.project)
    expect(f.contexts).toHaveLength(1)

    await f.ctx.fiber.dispose()

    expect(f.contexts).toHaveLength(0)
  })
})

describe('wiring edges', () => {
  it('registers nothing at all for a disabled deployment', async () => {
    const paths = await freshCase()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('fs', nodeFileSystem() as never)
    const contexts: unknown[] = []
    vi.spyOn(ctx.systemPrompt, 'context').mockImplementation((spec) => {
      contexts.push(spec)
      return () => {}
    })

    apply(ctx, { ledgerHome: paths.home, enabled: false })

    const agent = stubAgent(ctx, paths.project)
    const parallel = ctx.parallel.bind(ctx) as never as (event: string, payload: unknown) => Promise<void>
    await parallel('agent/created', { agent })
    expect(contexts).toEqual([])
  })

  it('ignores a tool result whose arguments are not an object', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    const { agent } = await createAgent(f, paths.project)

    await f.emit('tools/result', {
      name: 'read',
      agent,
      arguments: 'not an object',
      signal: new AbortController().signal,
    }, { isError: false })

    expect(f.warnings).toEqual([])
  })

  it('ignores a tool result whose file_path is not a string', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    const { agent } = await createAgent(f, paths.project)

    await touch(f, agent, 'read', { file_path: 42 })

    expect(f.warnings).toEqual([])
  })

  it('ignores a tool result that carries no agent', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    await createAgent(f, paths.project)

    await f.emit('tools/result', {
      name: 'ledger_write',
      arguments: {},
      signal: new AbortController().signal,
    }, { isError: false })

    expect(f.warnings).toEqual([])
  })

  it('ignores a tool result for a session that never resolved a project', async () => {
    const plain = await freshPlainDir()
    const f = await fixture()
    const { agent } = await createAgent(f, plain)

    await touch(f, agent, 'ledger_write', {})

    expect(f.warnings).toEqual([])
  })

  it('ignores a session event that is not a checkpoint', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    const { agent, block } = await createAgent(f, paths.project)
    const before = block()

    await f.emit('session/event', agent.session, { type: 'step/start' })

    expect(block()).toBe(before)
  })

  it('ignores a checkpoint for a session it does not track', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    const { block } = await createAgent(f, paths.project)
    const before = block()

    await f.emit('session/event', { id: 'another-session' }, { type: 'turn/start' })

    expect(block()).toBe(before)
  })

  it('delivers no conventions without a filesystem provider', async () => {
    const paths = await freshCase()
    await writeFile(join(paths.project, 'CONTEXT.md'), 'Root convention.\n')
    const f = await fixture({ paths, fs: undefined })
    const { agent } = await createAgent(f, paths.project)
    const injected = captureInjected(f, agent)

    await touch(f, agent, 'read', { file_path: join(paths.project, 'package.json') })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(injected()).toHaveLength(0)
    expect(f.warnings).toEqual([])
  })

  it('delivers no conventions when the session ceiling is switched off', async () => {
    const paths = await freshCase()
    await writeFile(join(paths.project, 'CONTEXT.md'), 'Root convention.\n')
    const f = await fixture({ paths, config: { budgetOverrides: { maxConventionSessionBytes: 0 } } })
    const { agent } = await createAgent(f, paths.project)
    const injected = captureInjected(f, agent)

    await touch(f, agent, 'read', { file_path: join(paths.project, 'package.json') })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(injected()).toHaveLength(0)
  })

  it('delivers nothing when the session ceiling cannot hold even one document', async () => {
    const paths = await freshCase()
    await writeFile(join(paths.project, 'CONTEXT.md'), 'Root convention.\n')
    const f = await fixture({ paths, config: { budgetOverrides: { maxConventionSessionBytes: 1 } } })
    const { agent } = await createAgent(f, paths.project)
    const injected = captureInjected(f, agent)

    await touch(f, agent, 'read', { file_path: join(paths.project, 'package.json') })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(injected()).toHaveLength(0)
    expect(f.warnings).toEqual([])
  })

  it('reports the measurement attempt behind an adaptive default rung', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths, config: { budgetProfile: 'adaptive' } })
    const { agent } = await createAgent(f, paths.project)

    const status = await runTool(f, agent, 'ledger_status', {}) as { adaptive: { configured: string; rung: string; basis: string } }

    expect(status.adaptive.configured).toBe('adaptive')
    // With no meter and no route the measurement cannot decide, so the default
    // rung applies and the reading says why.
    expect(status.adaptive.rung).toBe('balanced')
    expect(status.adaptive.basis).toMatch(/token meter only/u)
  })

  it('refuses a ledger tool call that has no agent', async () => {
    const paths = await freshCase()
    const f = await fixture({ paths })
    await createAgent(f, paths.project)

    const result = await f.ctx.tools.execute({
      name: 'ledger_read',
      arguments: { id: 'x' },
      callId: 'call-1' as never,
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/agent-scoped tool call/u)
  })
})

describe('archiving an empty log', () => {
  it('stores no row when the session recorded nothing', async () => {
    const paths = await freshCase()
    const f = await fixture({
      paths,
      services: {
        sessions: { async flush() {} },
        sessionQuery: { async readSession() { return { events: [] } } },
      },
    })
    const { agent } = await createAgent(f, paths.project)

    await f.emit('agent/disposed', { agent }, undefined)
    await new Promise(resolve => setTimeout(resolve, 30))

    expect((await storeFor(paths).listArchive()).rows).toHaveLength(0)
    expect(f.warnings).toEqual([])
  })
})

describe('a provider that reports no size', () => {
  it('treats an unknown size as no ceiling breach', async () => {
    const paths = await freshCase()
    await writeFile(join(paths.project, 'CONTEXT.md'), 'Root convention.\n')
    const inner = nodeFileSystem()
    const f = await fixture({
      paths,
      // A provider that resolves presence and content but never a size.
      fs: {
        resolve: inner.resolve,
        async stat(path, signal) {
          const info = await inner.stat(path, signal)
          if (info === undefined) return undefined
          // Report presence only: never a size, and a token only when there is one.
          return info.version === undefined ? {} : { version: info.version }
        },
        readText: inner.readText,
      },
    })
    const { agent } = await createAgent(f, paths.project)
    const injected = captureInjected(f, agent)

    await touch(f, agent, 'read', { file_path: join(paths.project, 'package.json') })

    expect(await waitFor(() => injected().length === 1)).toBe(true)
    expect(injected()[0]?.content[0]?.text ?? '').toContain('Root convention.')
    expect(f.warnings).toEqual([])
  })
})

describe('an adaptive measurement without a route to measure against', () => {
  it('reports the token count and omits the window it could not read', async () => {
    const paths = await freshCase()
    const f = await fixture({
      paths,
      config: { budgetProfile: 'adaptive' },
      services: { tokenMeter: { measure: () => ({ totalTokens: 7 }) } },
    })
    const { agent } = await createAgent(f, paths.project)

    const status = await runTool(f, agent, 'ledger_status', {}) as {
      adaptive: { basis: string; usedTokens?: number; contextWindow?: number }
    }

    expect(status.adaptive.usedTokens).toBe(7)
    expect(status.adaptive.contextWindow).toBeUndefined()
    expect(status.adaptive.basis).toMatch(/no routed model/u)
  })
})
