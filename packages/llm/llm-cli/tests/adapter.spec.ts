/**
 * Adapter behavior against a scripted CLI child. The child's stdout is driven
 * event by event rather than buffered, so every ordering the adapter has to
 * handle — trailing output after a terminal event, an end without a result, a
 * broken pipe — is expressed exactly, with no reliance on stream scheduling.
 *
 * `tests/plugin.spec.ts` covers the same code through a real child and real
 * pipes; this file covers the branches a real child makes hard to reach.
 */

import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { CliAdapter } from '../src/adapter.ts'
import type { CliConnectionOptions } from '../src/adapter.ts'

type SessionId = NonNullable<GenerateOptions['sessionId']>

/**
 * A stdout the test publishes on demand, which is what makes ordering exact. It
 * is a `Readable` so the seam's handle needs no cast, but it reads no source:
 * every event it reports is one the test raised, on the calling turn.
 */
class ManualStdout extends Readable {
  /** Publish one chunk, as the pipe delivers it. */
  data(text: string): void {
    this.emit('data', Buffer.from(text))
  }

  /** Publish the end of the stream. */
  end(): void {
    this.emit('end')
  }

  /** Publish a read failure. */
  fail(cause: Error): void {
    this.emit('error', cause)
  }

  /** Nothing to read: the test pushes every chunk this stream reports. */
  override _read(): void {}
}

/** One scripted CLI child: a stdout the test drives and an outcome it settles. */
class FakeChild {
  private readonly stream = new ManualStdout()
  private readonly outcome: Promise<SubprocessOutcome>
  private settle!: (outcome: SubprocessOutcome) => void
  /** Whether the handle exposes stdout at all. */
  readonly exposesStdout: boolean
  private readonly refusesJoin: boolean

  terminated = false
  waited = false

  constructor(exposesStdout: boolean, refusesJoin: boolean) {
    this.exposesStdout = exposesStdout
    this.refusesJoin = refusesJoin
    this.outcome = new Promise((resolve) => { this.settle = resolve })
  }

  /** Publish one raw stdout chunk, exactly as the pipe delivers it. */
  write(text: string): void {
    this.stream.data(text)
  }

  /** Close stdout without reporting an exit, as a closed pipe does. */
  end(): void {
    this.stream.end()
  }

  /** Break stdout, as a read error on the pipe does. */
  fail(cause: Error): void {
    this.stream.fail(cause)
  }

  /** Report the child's exit facts. */
  exit(exitCode: number | null): void {
    this.settle({ exitCode, signal: null })
  }

  /** Close stdout and report a clean exit. */
  finish(exitCode: number | null = 0): void {
    this.end()
    this.exit(exitCode)
  }

  handle(): SubprocessHandle {
    return {
      stdin: undefined,
      stdout: this.exposesStdout ? this.stream : undefined,
      stderr: undefined,
      control: undefined,
      collected: {},
      done: this.outcome,
      terminate: () => { this.terminated = true },
      waitForExit: () => {
        this.waited = true
        // A provider that can no longer observe its range rejects the join; the
        // adapter treats that as "nothing left to wait for".
        return this.refusesJoin ? Promise.reject(new Error('managed range is unobservable')) : Promise.resolve(true)
      },
    }
  }
}

/** A spawn stand-in that records specs and hands the test the child it created. */
class FakeSpawner {
  readonly specs: SubprocessSpawnSpec[] = []
  private readonly waiting: Array<(child: FakeChild) => void> = []
  private readonly ready: FakeChild[] = []

  constructor(
    private readonly exposesStdout = true,
    private readonly refusesJoin = false,
  ) {}

  readonly spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    this.specs.push(spec)
    const child = new FakeChild(this.exposesStdout, this.refusesJoin)
    const waiter = this.waiting.shift()
    if (waiter === undefined) this.ready.push(child)
    else waiter(child)
    return child.handle()
  }

  /** The child the adapter just spawned, as soon as it has spawned one. */
  child(): Promise<FakeChild> {
    const ready = this.ready.shift()
    if (ready !== undefined) return Promise.resolve(ready)
    return new Promise((resolve) => { this.waiting.push(resolve) })
  }
}

/** Executable facts the adapter is handed for one operation. */
const FACTS: CliConnectionOptions = {
  argv: ['codebuddy', '--print', '--output-format', 'stream-json'],
  cwd: '/configured',
  useSessionCwd: true,
  env: { NO_COLOR: '1' },
  sessionIdArg: '--session-id',
  transport: 'print',
  permissionMode: 'bypassPermissions',
  acpArgv: ['codebuddy', '--acp'],
  disposeGraceMs: 3_000,
  discoveryArgv: ['codebuddy', '--help'],
  discoveryTimeoutMs: 15_000,
  models: [],
}

/** The registry entry class this package owns. */
const PROVIDER = 'codebuddy-cli'

interface HarnessOptions {
  facts?: Partial<CliConnectionOptions>
  exposesStdout?: boolean
  refusesJoin?: boolean
  /**
   * The value the spawn seam throws. Typed as what it is — a raw value — because
   * one case pins how a non-Error throw reaches the caller.
   */
  spawnThrows?: unknown
  resolveSessionCwd?: (sessionId: SessionId) => string | undefined
  withResolver?: boolean
}

/** An adapter over a scripted spawn, plus the spawner and facts the test drives it with. */
function harness(options: HarnessOptions = {}) {
  const spawner = new FakeSpawner(options.exposesStdout ?? true, options.refusesJoin ?? false)
  // The adapter re-reads these per operation, so a test may adjust one fact
  // before it drives a run.
  const facts: CliConnectionOptions = { ...FACTS, ...options.facts }
  const adapter = new CliAdapter({
    options: () => facts,
    spawn: options.spawnThrows === undefined
      ? spawner.spawn
      : () => { throw options.spawnThrows },
    ...options.withResolver === false
      ? {}
      : { resolveSessionCwd: options.resolveSessionCwd ?? (() => undefined) },
  })
  return { adapter, facts, spawner }
}

/** A human-authored user message. */
function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One harness request over the given messages and fields. */
function ask(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: PROVIDER,
    model: 'gpt-5.6-sol',
    messages: [user('hi')],
    ...overrides,
  }
}

/** Render one stream-json frame with its newline. */
function frame(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

/** One cumulative assistant frame carrying the full text so far. */
function assistantFrame(text: string): string {
  return frame({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
}

/** One partial-message frame opening a CLI message. */
function messageStartFrame(): string {
  return frame({ type: 'stream_event', event: { type: 'message_start' } })
}

/** One partial-message frame carrying incremental answer text. */
function textDeltaFrame(text: string): string {
  return frame({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
  })
}

/** One terminal result frame. */
function resultFrame(fields: Record<string, unknown>): string {
  return frame({ type: 'result', ...fields })
}

/** Drive one stream to completion while the script feeds its child. */
async function run(
  created: ReturnType<typeof harness>,
  options: GenerateOptions,
  script: (child: FakeChild) => void,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  const pump = (async () => {
    for await (const chunk of created.adapter.stream(options)) chunks.push(chunk)
  })()
  const child = await created.spawner.child()
  script(child)
  await pump
  return chunks
}

describe('CliAdapter registry surface', () => {
  it('names the provider and lists its catalog as text-only models', async () => {
    const { adapter } = harness({ facts: { models: [{ id: 'a' }, { id: 'b', name: 'B' }] } })

    expect(adapter.providerInfo(PROVIDER)).toEqual({ id: PROVIDER, name: PROVIDER })
    expect(await adapter.listModels(PROVIDER)).toEqual([
      { provider: PROVIDER, id: 'a', name: 'a', inputModalities: ['text'] },
      { provider: PROVIDER, id: 'b', name: 'B', inputModalities: ['text'] },
    ])
    expect(await adapter.resolveModel(PROVIDER, 'whatever')).toEqual({
      provider: PROVIDER,
      id: 'whatever',
      name: 'whatever',
    })
  })
})

describe('CliAdapter stream translation', () => {
  it('streams one text block and settles on the CLI\'s result event', async () => {
    const created = harness()
    const chunks = await run(created, ask(), (child) => {
      // Cumulative frames: the second repeats the first and adds to it.
      child.write(assistantFrame('Hel'))
      child.write(assistantFrame('Hello'))
      child.write(resultFrame({ subtype: 'success', session_id: 's1', usage: { input_tokens: 5, output_tokens: 2 } }))
      child.finish()
    })

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('streams the partial-message deltas as they arrive, without repeating them', async () => {
    const created = harness()
    const chunks = await run(created, ask(), (child) => {
      // A partial-message run carries the text twice: once as deltas while the
      // CLI is still generating, once inside the completed message. Only the
      // deltas reach the caller early, and the completed frame adds nothing.
      child.write(messageStartFrame())
      child.write(textDeltaFrame('Hel'))
      child.write(textDeltaFrame('lo'))
      child.write(assistantFrame('Hello'))
      child.write(resultFrame({ subtype: 'success' }))
      child.finish()
    })

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('consumes a final line that never received its newline', async () => {
    const created = harness()
    const chunks = await run(created, ask(), (child) => {
      child.write(assistantFrame('late'))
      // No trailing newline: a child that exits mid-line still belongs to the run.
      child.write(JSON.stringify({ type: 'result', subtype: 'success' }))
      child.finish()
    })

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'late' })
  })

  it('emits no text block when the run produced none', async () => {
    const created = harness()
    const chunks = await run(created, ask(), (child) => {
      child.write(frame({ type: 'system', subtype: 'init' }))
      child.write('not json at all\n')
      child.write(resultFrame({ subtype: 'success' }))
      child.finish()
    })

    // Diagnostics and unmapped events are not model output: no block-start and
    // therefore no block-end either.
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('maps a turn-limit failure to an exhausted-budget finish', async () => {
    const created = harness()
    const chunks = await run(created, ask(), (child) => {
      child.write(assistantFrame('partial'))
      child.write(resultFrame({ subtype: 'error_max_turns', is_error: true }))
      child.finish()
    })

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
  })

  it('reports the CLI\'s own failure detail as an error finish', async () => {
    const created = harness()
    const chunks = await run(created, ask(), (child) => {
      child.write(resultFrame({ subtype: 'error_during_execution', is_error: true, result: 'rate limited' }))
      child.finish(1)
    })

    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'llm-cli: rate limited', code: 'CLI_RUN_FAILED' } } },
    ])
  })

  it('ignores everything the child writes after its terminal event', async () => {
    const created = harness()
    const chunks = await run(created, ask(), (child) => {
      child.write(assistantFrame('done'))
      child.write(resultFrame({ subtype: 'success' }))
      // Trailing output, a closed pipe, and a late read failure all arrive after
      // the run is settled and must not extend the answer.
      child.write(assistantFrame('done and more'))
      child.end()
      child.fail(new Error('too late'))
      child.exit(0)
    })

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'done' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('stops reading a chunk at the terminal event it contains', async () => {
    const created = harness()
    const chunks = await run(created, ask(), (child) => {
      // One chunk holding the terminal event and more lines after it: only the
      // answer that preceded the terminal belongs to this run.
      child.write(assistantFrame('done') + resultFrame({ subtype: 'success' }) + assistantFrame('done and more'))
      child.finish()
    })

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'done' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('reports an exit with no result event, naming the code and whether text arrived', async () => {
    const silent = harness()
    expect(await run(silent, ask(), (child) => { child.finish(3) })).toEqual([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'llm-cli: the CLI exited (3) without a result event', code: 'CLI_START_FAILED' } } },
    ])

    const partial = harness()
    const chunks = await run(partial, ask(), (child) => {
      child.write(assistantFrame('half'))
      child.finish(4)
    })
    // The assembled text still reaches the caller: it is the only record of
    // what the CLI said before it broke.
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'half' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'half' } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'llm-cli: the CLI exited (4) without a result event after producing text', code: 'CLI_START_FAILED' } } },
    ])
  })

  it('settles on a signal death without a result event too', async () => {
    const created = harness()
    const chunks = await run(created, ask(), (child) => {
      // exitCode null: the child died from a signal, which is still an exit.
      child.finish(null)
    })

    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'llm-cli: the CLI exited (null) without a result event', code: 'CLI_START_FAILED' } } },
    ])
  })

  it('reports a broken output stream as a start failure', async () => {
    const created = harness()
    const chunks = await run(created, ask(), (child) => {
      child.write(assistantFrame('x'))
      child.fail(new Error('ECONNRESET'))
      child.exit(1)
    })

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'x' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'llm-cli: the CLI output stream failed: ECONNRESET', code: 'CLI_START_FAILED' } } },
    ])
  })
})

describe('CliAdapter invocation', () => {
  it('carries the permission policy, model, system prompt, session id, and prompt in argv', async () => {
    const sessionId = brandString<SessionId>('sess-1')
    const created = harness()
    await run(
      created,
      ask({
        model: 'custom-local:deepseek-v4-pro',
        messages: [createSystemMessage('be terse'), user('latest')],
        sessionId,
      }),
      (child) => {
        child.write(resultFrame({ subtype: 'success' }))
        child.finish()
      },
    )

    expect(created.spawner.specs[0]).toEqual({
      argv: [
        'codebuddy', '--print', '--output-format', 'stream-json',
        '--permission-mode', 'bypassPermissions',
        '--model', 'custom-local:deepseek-v4-pro',
        // The system prompt moves to its own slot, out of the prompt text.
        '--append-system-prompt', 'be terse',
        '--session-id', 'sess-1',
        // A persistent session forwards only the newest human text: the CLI's
        // own session already owns the history.
        'latest',
      ],
      cwd: '/configured',
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 3_000,
      env: { NO_COLOR: '1' },
    })
  })

  it('bounds the delegated loop only when the facts carry a bound', async () => {
    const bare = harness()
    await run(bare, ask(), (child) => {
      child.write(resultFrame({ subtype: 'success' }))
      child.finish()
    })
    const bareArgv = bare.spawner.specs[0]?.argv ?? []
    expect(bareArgv).not.toContain('--tools')
    expect(bareArgv).not.toContain('--max-turns')
    expect(bareArgv).not.toContain('--effort')

    const bounded = harness({ facts: { tools: '', maxTurns: 1, effort: 'low' } })
    await run(bounded, ask(), (child) => {
      child.write(resultFrame({ subtype: 'success' }))
      child.finish()
    })
    const argv = bounded.spawner.specs[0]?.argv ?? []
    // An empty tool set travels as an empty argument: it is the CLI's spelling
    // for "run no tool at all", not a missing option.
    expect(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2)).toEqual(['--tools', ''])
    expect(argv.slice(argv.indexOf('--max-turns'), argv.indexOf('--max-turns') + 2)).toEqual(['--max-turns', '1'])
    expect(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2)).toEqual(['--effort', 'low'])
    // Whatever bounds the loop, the prompt stays the trailing positional one.
    expect(argv.at(-1)).toBe('User: hi')
  })

  it('flattens the whole conversation for a stateless call and omits the session argument', async () => {
    const created = harness()
    await run(
      created,
      ask({
        messages: [
          createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }),
          createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'p', model: 'm' } }),
        ],
      }),
      (child) => {
        child.write(resultFrame({ subtype: 'success' }))
        child.finish()
      },
    )

    const argv = created.spawner.specs[0]?.argv ?? []
    // Session titles and compaction have no CLI-side history, so the prompt is
    // the whole conversation and no session id is sent.
    expect(argv.at(-1)).toBe('User: first\n\nAssistant: answer')
    expect(argv).not.toContain('--session-id')
  })

  it('omits the session argument when the resolved facts disable it', async () => {
    const created = harness()
    // A stateless resolve carries no session argument at all, rather than an
    // empty one, so the fact itself is cleared.
    delete created.facts.sessionIdArg
    await run(created, ask({ sessionId: brandString<SessionId>('sess-1') }), (child) => {
      child.write(resultFrame({ subtype: 'success' }))
      child.finish()
    })

    expect(created.spawner.specs[0]?.argv).not.toContain('--session-id')
    // Without a session argument the CLI is stateless, so the newest human
    // text is still what it is handed.
    expect(created.spawner.specs[0]?.argv.at(-1)).toBe('hi')
  })

  it('runs a persistent call in the session workspace, falling back to the configured one', async () => {
    const created = harness({ resolveSessionCwd: sessionId => (sessionId === 'known' ? '/session-ws' : undefined) })

    await run(created, ask({ sessionId: brandString<SessionId>('known') }), (child) => {
      child.write(resultFrame({ subtype: 'success' }))
      child.finish()
    })
    await run(created, ask({ sessionId: brandString<SessionId>('unknown') }), (child) => {
      child.write(resultFrame({ subtype: 'success' }))
      child.finish()
    })

    expect(created.spawner.specs.map(spec => spec.cwd)).toEqual(['/session-ws', '/configured'])
  })

  it('keeps the configured workspace when it is explicitly pinned', async () => {
    // A deployment that named a cwd does not want a session to move the child.
    const created = harness({ facts: { useSessionCwd: false }, resolveSessionCwd: () => '/session-ws' })
    await run(created, ask({ sessionId: brandString<SessionId>('known') }), (child) => {
      child.write(resultFrame({ subtype: 'success' }))
      child.finish()
    })

    expect(created.spawner.specs[0]?.cwd).toBe('/configured')
  })

  it('mounts without a session-store lookup at all', async () => {
    // A composition without the session service runs every child in the
    // configured workspace instead of failing to construct.
    const created = harness({ withResolver: false })
    await run(created, ask({ sessionId: brandString<SessionId>('sess-1') }), (child) => {
      child.write(resultFrame({ subtype: 'success' }))
      child.finish()
    })

    expect(created.spawner.specs[0]?.cwd).toBe('/configured')
  })

  it('omits the system-prompt argument when the request carries no prompt', async () => {
    const created = harness()
    await run(created, ask(), (child) => {
      child.write(resultFrame({ subtype: 'success' }))
      child.finish()
    })

    expect(created.spawner.specs[0]?.argv).not.toContain('--append-system-prompt')
  })

  it('forwards the caller signal, disposes the child, and tolerates an unjoinable range', async () => {
    const controller = new AbortController()
    const created = harness({ refusesJoin: true })
    const spawned: FakeChild[] = []
    const chunks = await run(created, ask({ signal: controller.signal }), (child) => {
      spawned.push(child)
      child.write(resultFrame({ subtype: 'success' }))
      child.finish()
    })

    expect(created.spawner.specs[0]?.signal).toBe(controller.signal)
    // A provider that can no longer observe its range must not fail a run that
    // already produced its answer.
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(spawned[0]?.terminated).toBe(true)
    expect(spawned[0]?.waited).toBe(true)
  })
})

describe('CliAdapter refusals', () => {
  it('refuses an already-aborted request without spawning', async () => {
    const created = harness()
    const chunks: StreamChunk[] = []
    const controller = new AbortController()
    controller.abort()
    for await (const chunk of created.adapter.stream(ask({ signal: controller.signal }))) chunks.push(chunk)

    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'llm-cli: the request was aborted before the CLI child started', code: 'ABORTED' } } },
    ])
    expect(created.spawner.specs).toEqual([])
  })

  it('refuses a request with no text the CLI can consume', async () => {
    const created = harness()
    const chunks: StreamChunk[] = []
    for await (const chunk of created.adapter.stream(ask({ messages: [] }))) chunks.push(chunk)

    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'llm-cli: the request carries no text the CLI can consume', code: 'INVALID_REQUEST' } } },
    ])

    const persistent = harness()
    const sessionChunks: StreamChunk[] = []
    for await (const chunk of persistent.adapter.stream(ask({ messages: [], sessionId: brandString<SessionId>('s') }))) {
      sessionChunks.push(chunk)
    }
    expect(sessionChunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  })

  it('reports an unstartable child instead of throwing', async () => {
    const created = harness({ spawnThrows: new Error('ENOENT: codebuddy not found') })
    const chunks: StreamChunk[] = []
    for await (const chunk of created.adapter.stream(ask())) chunks.push(chunk)

    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'llm-cli: the CLI child could not be started: ENOENT: codebuddy not found', code: 'CLI_START_FAILED' } } },
    ])
  })

  it('reports a non-Error start failure with its stringified cause', async () => {
    const created = harness({ spawnThrows: 'not an Error' })
    const chunks: StreamChunk[] = []
    for await (const chunk of created.adapter.stream(ask())) chunks.push(chunk)

    expect(chunks[0]).toMatchObject({ reason: { failure: { message: 'llm-cli: the CLI child could not be started: not an Error' } } })
  })

  it('reports a child with no stdout to read', async () => {
    const created = harness({ exposesStdout: false })
    const chunks: StreamChunk[] = []
    for await (const chunk of created.adapter.stream(ask())) chunks.push(chunk)

    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'llm-cli: the CLI child has no stdout to read stream-json from', code: 'CLI_START_FAILED' } } },
    ])
  })

  it('settles as aborted when the caller cancels mid-run', async () => {
    const controller = new AbortController()
    const created = harness()
    const chunks: StreamChunk[] = []
    const pump = (async () => {
      for await (const chunk of created.adapter.stream(ask({ signal: controller.signal }))) chunks.push(chunk)
    })()
    const child = await created.spawner.child()
    child.write(assistantFrame('stopped'))
    controller.abort()
    child.exit(null)
    await pump

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'aborted', failure: { message: 'llm-cli: the CLI run was aborted', code: 'ABORTED' } },
    })
    // Text produced before the abort still reaches the caller.
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'stopped' } })
    expect(child.terminated).toBe(true)
    expect(child.waited).toBe(true)
  })

  it('ignores output that arrives after a mid-run cancellation', async () => {
    const controller = new AbortController()
    const created = harness()
    const chunks: StreamChunk[] = []
    const pump = (async () => {
      for await (const chunk of created.adapter.stream(ask({ signal: controller.signal }))) chunks.push(chunk)
    })()
    const child = await created.spawner.child()
    controller.abort()
    // The child is already being torn down; whatever it wrote on the way out is
    // no longer part of this run.
    child.write(assistantFrame('too late'))
    child.end()
    child.exit(null)
    await pump

    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'llm-cli: the CLI run was aborted', code: 'ABORTED' } } },
    ])
  })

  it('keeps the CLI\'s own terminal when the caller cancels after it', async () => {
    const controller = new AbortController()
    const created = harness()
    const chunks: StreamChunk[] = []
    const pump = (async () => {
      for await (const chunk of created.adapter.stream(ask({ signal: controller.signal }))) chunks.push(chunk)
    })()
    const child = await created.spawner.child()
    // The terminal and the cancellation arrive in the same tick, with no await
    // between them: the child reported its outcome first, and a cancellation
    // that lands afterwards cannot retract an answer already settled.
    child.write(resultFrame({ subtype: 'success' }))
    controller.abort()
    child.finish()
    await pump

    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(child.terminated).toBe(true)
  })
})
