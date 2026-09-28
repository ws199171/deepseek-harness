/**
 * `CliAdapter`: the delegating LLM adapter that answers one model call by
 * running one CLI child process and translating its stream-json output into
 * harness `StreamChunk`s. The configured CLI (CodeBuddy by default) carries its
 * own authentication and runs its own agentic loop with its own tools, so the
 * harness forwards conversation text and receives the final answer: no API key,
 * no harness-side tool loop, and no harness tool vocabulary on the wire.
 *
 * The adapter is transport-only. Executable facts arrive through a thunk
 * resolved once per operation, and the registering plugin owns validation,
 * defaults, and configuration — so a settings change reaches the next call
 * without re-registering this route.
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
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { parseCliLine } from './wire.ts'
import { flattenConversation, systemTextOf, trailingUserText } from './translate.ts'

/** One optional model entry the CLI route advertises. */
export interface CliCatalogModel {
  /** Model id accepted by {@link GenerateOptions.model} for this route. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
}

/** The CLI permission modes its non-interactive print command accepts. */
export const CODEBUDDY_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'plan',
  'dontAsk',
  'auto',
] as const

/** The delegated CLI's policy for approving tools inside its own agent loop. */
export type CodeBuddyPermissionMode = typeof CODEBUDDY_PERMISSION_MODES[number]

/**
 * Validated executable facts for one operation. The plugin's resolve step
 * produces this shape; the adapter trusts it and re-reads it per operation.
 */
export interface CliConnectionOptions {
  /** Executable and base arguments; `argv[0]` is the program. */
  argv: readonly string[]
  /** Configured working directory, or the process fallback for the CLI child. */
  cwd: string
  /** Whether a persistent session's own workspace replaces {@link cwd} when one is available. */
  useSessionCwd: boolean
  /** Explicit environment entries layered over the subprocess seam's base. */
  env: Record<string, string>
  /** Argument carrying the persistent session id, or undefined for stateless runs. */
  sessionIdArg?: string
  /** The CLI's permission policy for tools its own loop executes. */
  permissionMode: CodeBuddyPermissionMode
  /** Grace in milliseconds for child process-tree termination. */
  disposeGraceMs: number
  /** Executable and arguments that print the CLI's supported model ids. */
  discoveryArgv: readonly string[]
  /** Hard ceiling in milliseconds for one model-discovery child. */
  discoveryTimeoutMs: number
  /** Advisory models exposed to discovery consumers. */
  models: readonly CliCatalogModel[]
}

/** Constructor options for {@link CliAdapter}. */
export interface CliAdapterOptions {
  /** Current validated executable facts; read once per operation. */
  options: () => CliConnectionOptions
  /** The subprocess seam's spawn operation. */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Resolve the workspace selected for a persistent harness session. */
  resolveSessionCwd?: (sessionId: NonNullable<GenerateOptions['sessionId']>) => string | undefined
}

/** Failure code reported when the child cannot be started or breaks its protocol. */
const CLI_START_FAILED_CODE = 'CLI_START_FAILED'

/** Render one terminal failure chunk, classified as aborted when the signal fired. */
function failureChunk(message: string, code: string, signal?: AbortSignal): StreamChunk {
  return {
    type: 'finish',
    reason: signal?.aborted === true
      ? { kind: 'aborted', failure: { message, code } }
      : { kind: 'error', failure: { message, code } },
  }
}

/**
 * A single-consumer handoff between the stdout callbacks that produce chunks and
 * the generator that yields them. Closing it ends consumption once drained, so
 * a terminal event or a stream end settles the generator without the callbacks
 * knowing about it.
 */
class ChunkQueue {
  private readonly items: StreamChunk[] = []
  private waiter: (() => void) | undefined
  private closed = false

  /** Append chunks and wake a waiting consumer. */
  push(...chunks: StreamChunk[]): void {
    this.items.push(...chunks)
    this.wake()
  }

  /** Close the queue; the consumer ends once every queued chunk is drained. */
  close(): void {
    this.closed = true
    this.wake()
  }

  /** @returns the next queued chunk, or undefined once closed and drained. */
  async next(): Promise<StreamChunk | undefined> {
    while (this.items.length === 0) {
      if (this.closed) return undefined
      await new Promise<void>((resolve) => { this.waiter = resolve })
    }
    return this.items.shift()
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }
}

/**
 * Delegating CLI adapter: one provider route whose model ids name the CLI's own
 * model selection. Every `stream` call spawns a fresh child, hands it the
 * prompt as its final positional argument, and consumes stream-json on stdout.
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
    if (signal?.aborted === true) {
      yield failureChunk('llm-cli: the request was aborted before the CLI child started', 'ABORTED', signal)
      return
    }

    // A persistent session forwards only the newest human text: the CLI's own
    // session, keyed through sessionIdArg, already owns the history. Stateless
    // callers (session titles, compaction) flatten the whole conversation.
    const sessionId = options.sessionId
    const prompt = sessionId === undefined
      ? flattenConversation(options.messages)
      : trailingUserText(options.messages)
    if (prompt === undefined) {
      yield failureChunk('llm-cli: the request carries no text the CLI can consume', 'INVALID_REQUEST')
      return
    }

    // CodeBuddy-style CLIs read the prompt from the trailing positional
    // argument, not stdin, so argv stays constant per resolution.
    const argv = [...facts.argv, '--permission-mode', facts.permissionMode, '--model', options.model]
    const system = systemTextOf(options.messages, options.system)
    if (system !== undefined) argv.push('--append-system-prompt', system)
    if (sessionId !== undefined && facts.sessionIdArg !== undefined) argv.push(facts.sessionIdArg, sessionId)
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
      yield failureChunk(`llm-cli: the CLI child could not be started: ${message}`, CLI_START_FAILED_CODE, signal)
      return
    }
    const stdout = child.stdout
    if (stdout === undefined) {
      yield failureChunk('llm-cli: the CLI child has no stdout to read stream-json from', CLI_START_FAILED_CODE, signal)
      return
    }

    const queue = new ChunkQueue()
    let buffer = ''
    let lastText = ''
    let blockStarted = false
    let settled = false
    let pendingUsage: StreamChunk | undefined
    let finish: StreamChunk | undefined

    /**
     * Translate one stdout line into queued chunks and, at most once, a terminal.
     * @param line - one complete stdout line, newline removed.
     * @returns whether the line carried the run's terminal event.
     */
    const acceptLine = (line: string): boolean => {
      const event = parseCliLine(line, lastText)
      if (event === undefined || event.kind === 'ignored') return false
      if (event.kind === 'text') {
        if (!blockStarted) {
          blockStarted = true
          queue.push({ type: 'block-start', index: 0, blockType: 'text' })
        }
        lastText += event.delta.text
        queue.push({ type: 'text-delta', index: 0, text: event.delta.text })
        return false
      }
      const terminal = event.terminal
      if (terminal.kind === 'stop') {
        // Usage precedes the terminal finish and block-end precedes both, so
        // the terminal is staged rather than queued.
        if (terminal.usage !== undefined) pendingUsage = { type: 'usage', usage: terminal.usage }
        finish = { type: 'finish', reason: { kind: 'stop' } }
      } else if (terminal.kind === 'max-turns') {
        finish = { type: 'finish', reason: { kind: 'max-tokens' } }
      } else {
        finish = failureChunk(`llm-cli: ${terminal.failure.message}`, terminal.failure.code, signal)
      }
      settled = true
      queue.close()
      return true
    }

    const onData = (data: Buffer): void => {
      if (settled) return
      buffer += data.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        // A terminal event ends the run: anything after it in the same chunk is
        // the child's own trailing output, not more of the answer.
        if (acceptLine(line)) break
      }
    }
    const onEnd = (): void => {
      if (!settled) {
        // A final line without its newline still belongs to the run.
        if (buffer.trim().length > 0) acceptLine(buffer)
        settled = true
      }
      queue.close()
    }
    const onError = (error: Error): void => {
      if (!settled) {
        settled = true
        finish ??= failureChunk(`llm-cli: the CLI output stream failed: ${error.message}`, CLI_START_FAILED_CODE, signal)
      }
      queue.close()
    }
    const onAbort = (): void => {
      // The subprocess seam owns tree termination through the spec's signal;
      // this listener only settles the pump. Settling here is what keeps a
      // cancelled run from appending whatever the dying child still writes:
      // text that arrives after the caller cancelled is not part of the answer.
      // The cancellation also outranks a terminal the child already reported,
      // so it is staged as the finish rather than tracked beside it.
      if (settled) return
      settled = true
      finish = failureChunk('llm-cli: the CLI run was aborted', 'ABORTED', signal)
      queue.close()
    }

    stdout.on('data', onData)
    stdout.on('end', onEnd)
    stdout.on('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      for (;;) {
        const chunk = await queue.next()
        if (chunk === undefined) break
        yield chunk
      }
      // The StreamChunk protocol puts block-end before the terminal finish.
      if (lastText.length > 0) {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: lastText } }
      }
      if (pendingUsage !== undefined) yield pendingUsage
      if (finish !== undefined) {
        yield finish
        return
      }
      // The child ended without a result event: its exit is the only outcome.
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
      child.terminate()
      // The seam owns escalation; a provider that can no longer observe its
      // range has already ended every process the run could still own.
      await child.waitForExit().catch(() => {})
    }
  }
}
