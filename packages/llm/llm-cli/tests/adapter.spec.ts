import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { CliAdapter } from '../src/adapter.ts'
import type { CliConnectionOptions } from '../src/adapter.ts'
import { resolveAdapterOptions } from '../src/index.ts'

let testDir: string

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'dsh-llm-cli-'))
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

function user(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** The fixture CLI: echoes a fixed stream-json conversation into stdout. */
const FIXTURE_CLI = `\
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hel' }] } }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello from CLI' }] } }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hello from CLI', session_id: 'fixture-session', usage: { input_tokens: 10, output_tokens: 3 } }) + '\\n')
`

/** The streaming fixture writes its result only after the first text event. */
const STREAMING_FIXTURE_CLI = `\
const { writeFileSync } = require('node:fs')
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Early text' }] } }) + '\\n')
setTimeout(() => {
  writeFileSync(process.argv.at(-1), 'result')
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Early text' }) + '\\n')
}, 100)
`

/** The failing fixture CLI: exits non-zero without a result event. */
const FAILING_CLI = `\
process.exit(3)
`

/** The argv fixture captures the model flag before returning a complete stream. */
const ARGV_FIXTURE_CLI = `\
const { writeFileSync } = require('node:fs')
writeFileSync(process.argv.at(-1), JSON.stringify(process.argv.slice(2, -1)))
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) + '\\n')
`

/** The cwd fixture records the child working directory before completing. */
const CWD_FIXTURE_CLI = `\
const { writeFileSync } = require('node:fs')
writeFileSync(process.argv.at(-1), process.cwd())
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) + '\\n')
`

async function harness(script: string, facts: Partial<CliConnectionOptions> = {}) {
  const scriptPath = join(testDir, 'fixture-cli.cjs')
  writeFileSync(scriptPath, script)
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const adapter = new CliAdapter({
    options: () => ({
      argv: [process.execPath, scriptPath],
      cwd: testDir,
      useSessionCwd: false,
      env: {},
      permissionMode: 'bypassPermissions',
      disposeGraceMs: 3_000,
      models: [{ id: 'fixture', name: 'Fixture CLI' }],
      ...facts,
    }),
    spawn: spec => ctx.subprocess.spawn(spec),
  })
  return { ctx, adapter }
}

async function collect(stream: AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>) {
  const chunks: import('@deepseek-ai/dsh-llm').StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('CliAdapter', () => {
  it('streams a CLI run end to end as one text block', async () => {
    const { adapter } = await harness(FIXTURE_CLI)
    const chunks = await collect(adapter.stream({
      provider: 'cli',
      model: 'fixture',
      messages: [user('hi')],
    }))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo from CLI' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello from CLI' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('yields text before the child emits its result event', async () => {
    const resultMarker = join(testDir, 'result-marker')
    const { adapter } = await harness(STREAMING_FIXTURE_CLI)
    const iterator = adapter.stream({
      provider: 'cli',
      model: 'fixture',
      sessionId: SessionId('harness-session'),
      messages: [user(resultMarker)],
    })[Symbol.asyncIterator]()

    expect(await iterator.next()).toEqual({
      value: { type: 'block-start', index: 0, blockType: 'text' },
      done: false,
    })
    expect(await iterator.next()).toEqual({
      value: { type: 'text-delta', index: 0, text: 'Early text' },
      done: false,
    })
    expect(existsSync(resultMarker)).toBe(false)

    await iterator.return?.()
  })

  it('appends the session id argument for persistent sessions', async () => {
    const { adapter } = await harness(FIXTURE_CLI, { sessionIdArg: '--session-id' })
    const chunks = await collect(adapter.stream({
      provider: 'cli',
      model: 'fixture',
      sessionId: SessionId('harness-session'),
      messages: [user('new question')],
    }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('forwards the selected model with CodeBuddy\'s model flag', async () => {
    const argsPath = join(testDir, 'argv.json')
    const { adapter } = await harness(ARGV_FIXTURE_CLI, { sessionIdArg: '--session-id' })
    await collect(adapter.stream({
      provider: 'cli',
      model: 'fixture',
      sessionId: SessionId('harness-session'),
      system: 'Harness system prompt',
      messages: [user(argsPath)],
    }))
    expect(JSON.parse(String(readFileSync(argsPath))))
      .toEqual([
        '--permission-mode', 'bypassPermissions',
        '--model', 'fixture',
        '--append-system-prompt', 'Harness system prompt',
        '--session-id', 'harness-session',
      ])
  })

  it('defaults delegated CodeBuddy runs to non-interactive full access', () => {
    expect(resolveAdapterOptions({}, testDir).permissionMode).toBe('bypassPermissions')
  })

  it('uses the persistent session workspace when cwd is not configured', async () => {
    const workspace = join(testDir, 'workspace')
    const cwdPath = join(testDir, 'cwd.txt')
    const { ctx } = await harness(CWD_FIXTURE_CLI, { useSessionCwd: true })
    mkdirSync(workspace)
    const sessionId = SessionId('workspace-session')
    const workspaceAdapter = new CliAdapter({
      options: () => ({
        argv: [process.execPath, join(testDir, 'fixture-cli.cjs')],
        cwd: testDir,
        useSessionCwd: true,
        env: {},
        permissionMode: 'bypassPermissions',
        disposeGraceMs: 3_000,
        models: [{ id: 'fixture' }],
      }),
      spawn: spec => ctx.subprocess.spawn(spec),
      resolveSessionCwd: id => id === sessionId ? workspace : undefined,
    })
    await collect(workspaceAdapter.stream({
      provider: 'cli',
      model: 'fixture',
      sessionId,
      messages: [user(cwdPath)],
    }))
    expect(realpathSync(String(readFileSync(cwdPath)))).toBe(realpathSync(workspace))
  })

  it('reports a child that exits without a result event as an error', async () => {
    const { adapter } = await harness(FAILING_CLI)
    const chunks = await collect(adapter.stream({
      provider: 'cli',
      model: 'fixture',
      messages: [user('hi')],
    }))
    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type === 'finish') {
      expect(finish.reason.kind).toBe('error')
      if (finish.reason.kind === 'error') {
        expect(finish.reason.failure.message).toContain('without a result event')
      }
    }
  })

  it('refuses a request with no text content', async () => {
    const { adapter } = await harness(FIXTURE_CLI)
    const chunks = await collect(adapter.stream({
      provider: 'cli',
      model: 'fixture',
      messages: [],
    }))
    const finish = chunks[0]
    expect(finish?.type).toBe('finish')
    if (finish?.type === 'finish' && finish.reason.kind === 'error') {
      expect(finish.reason.failure.code).toBe('INVALID_REQUEST')
    }
  })

  it('aborts an in-flight run when the signal fires', async () => {
    const { adapter } = await harness(FIXTURE_CLI)
    const controller = new AbortController()
    controller.abort()
    const chunks = await collect(adapter.stream({
      provider: 'cli',
      model: 'fixture',
      messages: [user('hi')],
      signal: controller.signal,
    }))
    const finish = chunks[0]
    expect(finish?.type).toBe('finish')
    if (finish?.type === 'finish') {
      expect(finish.reason.kind).toBe('aborted')
    }
  })
})
