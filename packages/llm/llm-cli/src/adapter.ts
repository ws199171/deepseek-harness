/**
 * `CliAdapter`: the delegating LLM adapter that runs one CLI child process
 * per model call and translates its stream-json output into harness
 * StreamChunks. The CLI runs its own agentic loop with its own tools — the
 * harness only forwards conversation text and receives the final answer, so
 * no API key and no harness-side tool loop is involved. The adapter is
 * transport-only: executable facts arrive through a thunk resolved once per
 * operation, and the registering plugin owns validation and defaults.
 *
 * @module @deepseek-ai/dsh-llm-cli/adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SubprocessSpawnSpec, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { parseCliLine } from './wire.ts'
import { flattenConversation, trailingUserText } from './translate.ts'

/** One optional model entry advertised by the CLI adapter. */
export interface CliCatalogModel {
  /** Model id accepted by {@link GenerateOptions.model} for this route. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
}

/** CodeBuddy permission modes accepted by its non-interactive print command. */
export const CODEBUDDY_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'plan',
  'dontAsk',
  'auto',
] as const

/** CodeBuddy's policy for approving tools inside its delegated agent loop. */
export type CodeBuddyPermissionMode = typeof CODEBUDDY_PERMISSION_MODES[number]

/** Permission mode that makes delegated, non-interactive CodeBuddy runs usable by default. */
export const DEFAULT_CODEBUDDY_PERMISSION_MODE: CodeBuddyPermissionMode = 'bypassPermissions'

/**
 * Validated executable facts for one operation. The plugin's resolve step
 * produces this shape; the adapter trusts it and re-reads it per operation.
 */
export interface CliConnectionOptions {
  /** Executable and base arguments (never shell-interpreted on POSIX). */
  argv: readonly string[]
  /** Configured working directory or process fallback for the CLI child. */
  cwd: string
  /** Whether a session workspace replaces {@link cwd} when one is available. */
  useSessionCwd: boolean
  /** Explicit environment entries layered over the subprocess seam's base. */
  env: Record<string, string>
  /** Argument that carries the persistent session id, or undefined for stateless runs. */
  sessionIdArg?: string
  /** CodeBuddy's permission policy for tools executed inside the delegated run. */
  permissionMode: CodeBuddyPermissionMode
  /** Grace in milliseconds for child process-tree termination. */
  disposeGraceMs: number
  /** Advisory models exposed to discovery consumers. */
  models: readonly CliCatalogModel[]
}

/** Constructor options for {@link CliAdapter}. */
export interface CliAdapterOptions {
  /** Current validated executable facts; called once per operation. */
  options: () => CliConnectionOptions
  /** The subprocess seam's spawn operation. */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Resolve the workspace selected for a persistent Harness session. */
  resolveSessionCwd?: (sessionId: NonNullable<GenerateOptions['sessionId']>) => string | undefined
}

/** Default graceful-termination window for a CLI child. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Failure codes shared by child-startup and protocol failures. */
const CLI_START_FAILED_CODE = 'CLI_START_FAILED'

/** Render one non-empty failure chunk (stable taxonomy). */
function failureChunk(message: string, code: string, signal?: AbortSignal): StreamChunk {
  return {
    type: 'finish',
    reason: signal?.aborted
      ? { kind: 'aborted', failure: { message, code } }
      : { kind: 'error', failure: { message, code } },
  }
}

/**
 * Delegating CLI adapter. Registers one provider route whose model ids name
 * the CLI backends; every stream call spawns a
 * fresh child, writes the prompt, and consumes stream-json output lines.
 */
export class CliAdapter extends LlmAdapter {
  private readonly options: CliAdapterOptions['options']
  private readonly spawn: CliAdapterOptions['spawn']
  private readonly resolveSessionCwd: NonNullable<CliAdapterOptions['resolveSessionCwd']>

  constructor(options: CliAdapterOptions) {
    super()
    this.options = options.options
    this.spawn = options.spawn
    this.resolveSessionCwd = options.resolveSessionCwd ?? (() => undefined)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.options().models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: ['text'],
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const facts = this.options()
    const signal = options.signal
    if (signal?.aborted) {
      yield failureChunk('llm-cli: request was aborted before the CLI child started', 'ABORTED', signal)
      return
    }

    // A persistent session forwards only the newest user text: the CLI's own
    // session (keyed through sessionIdArg) owns the history. Stateless runs
    // flatten the whole conversation instead.
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined
    const prompt = sessionId === undefined
      ? flattenConversation(options.messages)
      : trailingUserText(options.messages)
    if (prompt === undefined) {
      yield failureChunk('llm-cli: the request carries no text the CLI can consume', 'INVALID_REQUEST')
      return
    }

    // CodeBuddy-style CLIs read the prompt from the positional argument, not
    // stdin; argv stays constant per resolution (no shell interpretation).
    const argv = [...facts.argv]
    argv.push('--permission-mode', facts.permissionMode)
    argv.push('--model', options.model)
    if (options.system !== undefined && options.system.length > 0) {
      argv.push('--append-system-prompt', options.system)
    }
    if (sessionId !== undefined && facts.sessionIdArg !== undefined) {
      argv.push(facts.sessionIdArg, sessionId)
    }
    argv.push(prompt)
    const cwd = sessionId !== undefined && facts.useSessionCwd
      ? this.resolveSessionCwd(sessionId) ?? facts.cwd
      : facts.cwd

    let child: SubprocessHandle
    try {
      child = this.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
        graceMs: facts.disposeGraceMs,
        env: facts.env,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      yield failureChunk(`llm-cli: failed to start the CLI child: ${message}`, CLI_START_FAILED_CODE, signal)
      return
    }
    if (child.pid <= 0) {
      yield failureChunk('llm-cli: the CLI child failed to spawn', CLI_START_FAILED_CODE, signal)
      return
    }
    const stdout = child.stdout
    if (stdout === undefined) {
      yield failureChunk('llm-cli: the CLI child has no stdout for stream-json', CLI_START_FAILED_CODE, signal)
      return
    }

    // State shared by the stdout line-scan and the pump loop below.
    const chunkQueue: StreamChunk[] = []
    let blockStarted = false
    let lastText = ''
    let terminal = false
    let streamDone = false
    let wake: (() => void) | undefined
    let buffer = ''
    // The stop terminal may carry token usage; it is yielded after block-end
    // and before the finish chunk, per the StreamChunk protocol.
    let pendingUsage: StreamChunk | undefined

    const isSettled = (): boolean => terminal || streamDone

    /** Translate one parsed line into zero or more queued chunks. */
    const acceptLine = (line: string): void => {
      const event = parseCliLine(line, lastText)
      if (event === undefined || event.kind === 'ignored') return
      if (event.kind === 'text') {
        lastText += event.delta.text
        if (!blockStarted) {
          blockStarted = true
          chunkQueue.push({ type: 'block-start', index: 0, blockType: 'text' })
        }
        if (event.delta.text.length > 0) {
          chunkQueue.push({ type: 'text-delta', index: 0, text: event.delta.text })
        }
        return
      }
      const t = event.terminal
      if (t.kind === 'stop') {
        // Usage precedes the terminal finish per the StreamChunk protocol;
        // it is staged and yielded after block-end, before the finish chunk.
        if (t.usage !== undefined) pendingUsage = { type: 'usage', usage: t.usage }
        chunkQueue.push({ type: 'finish', reason: { kind: 'stop' } })
      } else if (t.kind === 'max-turns') {
        chunkQueue.push({ type: 'finish', reason: { kind: 'max-tokens' } })
      } else {
        chunkQueue.push(failureChunk(`llm-cli: ${t.failure.message}`, t.failure.code, signal))
      }
      terminal = true
    }

    const onData = (data: Buffer): void => {
      buffer += data.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        acceptLine(line)
      }
      wake?.()
    }
    const onEnd = (): void => {
      if (buffer.trim().length > 0) {
        acceptLine(buffer)
        buffer = ''
      }
      streamDone = true
      wake?.()
    }
    const onError = (error: Error): void => {
      // A pipe error mid-stream is a protocol failure; it settles the pump
      // through the same terminal path as an early exit.
      chunkQueue.push(failureChunk(`llm-cli: the CLI output stream failed: ${error.message}`, CLI_START_FAILED_CODE, signal))
      terminal = true
      streamDone = true
      wake?.()
    }
    const onAbort = (): void => {
      // The subprocess seam's abort signal owns tree termination; this
      // listener only settles the pump so the generator stops consuming.
      streamDone = true
      wake?.()
    }

    stdout.on('data', onData)
    stdout.on('end', onEnd)
    stdout.on('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      // The pump: drain non-terminal chunks (block-start, text deltas), wait
      // for stdout activity, then settle. The StreamChunk protocol requires
      // block-end BEFORE the terminal finish, so the finish chunk is split
      // from the queue and yielded last.
      const drainExceptFinish = function* (): Generator<StreamChunk> {
        while (chunkQueue.length > 0 && chunkQueue[0]?.type !== 'finish') {
          yield chunkQueue.shift() as StreamChunk
        }
      }
      while (!isSettled()) {
        yield * drainExceptFinish()
        if (isSettled()) break
        await new Promise<void>((resolve) => { wake = resolve })
      }
      yield * drainExceptFinish()
      if (lastText.length > 0) {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: lastText } }
      }
      if (pendingUsage !== undefined) {
        yield pendingUsage
      }
      if (signal?.aborted) {
        yield failureChunk('llm-cli: the CLI run was aborted', 'ABORTED', signal)
        return
      }
      const queuedFinish = chunkQueue.find(chunk => chunk.type === 'finish')
      if (queuedFinish !== undefined) {
        yield queuedFinish
        return
      }
      // The child ended without a result event: wait for its exit and report
      // the outcome as a failed run.
      const outcome = await child.done
      const detail = lastText.length > 0
        ? `the CLI exited (${String(outcome.exitCode)}) without a result event after producing text`
        : `the CLI exited (${String(outcome.exitCode)}) without a result event`
      yield failureChunk(`llm-cli: ${detail}`, CLI_START_FAILED_CODE)
    } finally {
      stdout.off('data', onData)
      stdout.off('end', onEnd)
      stdout.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
      if (child.pid > 0) {
        try { child.stdin?.end() } catch { /* already closed */ }
        child.terminate()
        await child.waitForExit().catch(() => {})
      }
    }
  }
}
