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
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AcpTransport } from './acp.ts'
import type { AcpTransportOptions, AcpTurnEvent } from './acp.ts'
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

/** The reasoning effort levels the CLI's own flag accepts. */
export const CODEBUDDY_EFFORT_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

/** Reasoning effort the delegated CLI forwards to the model. */
export type CodeBuddyEffort = typeof CODEBUDDY_EFFORT_LEVELS[number]

/** The ways this route can reach the CLI. */
export const CLI_TRANSPORTS = ['print', 'acp'] as const

/**
 * How one call reaches the CLI: `print` starts a child per call and reads its
 * stream-json, `acp` keeps one child per route and prompts a session on it.
 * `print` is the default because it needs nothing of the CLI but its own
 * non-interactive mode.
 */
export type CliTransport = typeof CLI_TRANSPORTS[number]

/** Transport a deployment gets without asking for one. */
export const DEFAULT_TRANSPORT: CliTransport = 'print'

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
  /** How a call reaches the CLI; see {@link CliTransport}. */
  transport: CliTransport
  /** The CLI's permission policy for tools its own loop executes. */
  permissionMode: CodeBuddyPermissionMode
  /** Tool set the CLI restricts itself to; an empty value disables every built-in tool. Absent leaves its own default. */
  tools?: string
  /** Cap on the CLI's own agentic turns; absent leaves its own default. */
  maxTurns?: number
  /** Reasoning effort the CLI forwards to the model; absent leaves its own default. */
  effort?: CodeBuddyEffort
  /** Grace in milliseconds for child process-tree termination. */
  disposeGraceMs: number
  /** Executable and arguments that start the CLI as a long-lived ACP agent. */
  acpArgv: readonly string[]
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
 * model selection. Its default transport spawns a child per call, hands it the
 * prompt as its final positional argument, and consumes stream-json on stdout;
 * the ACP transport keeps one child per route and prompts a session on it, so
 * the CLI's cold start is paid once per route instead of once per call.
 */
export class CliAdapter extends LlmAdapter {
  private readonly options: CliAdapterOptions['options']
  private readonly spawn: CliAdapterOptions['spawn']
  private readonly resolveSessionCwd: NonNullable<CliAdapterOptions['resolveSessionCwd']>
  /** The long-lived ACP connection, replaced when what starts its child changes. */
  private acp: { signature: string; transport: AcpTransport } | undefined
  /** Numbers the throwaway sessions a stateless call gets. */
  private statelessCalls = 0

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
    // The delegated loop's own bounds, passed only when the deployment set one:
    // an empty `tools` is a value (every built-in tool off), not an absence.
    if (facts.tools !== undefined) argv.push('--tools', facts.tools)
    if (facts.maxTurns !== undefined) argv.push('--max-turns', String(facts.maxTurns))
    if (facts.effort !== undefined) argv.push('--effort', facts.effort)
    const system = systemTextOf(options.messages, options.system)
    if (system !== undefined) argv.push('--append-system-prompt', system)
    if (sessionId !== undefined && facts.sessionIdArg !== undefined) argv.push(facts.sessionIdArg, sessionId)
    argv.push(prompt)
    const cwd = sessionId !== undefined && facts.useSessionCwd
      ? this.resolveSessionCwd(sessionId) ?? facts.cwd
      : facts.cwd

    if (facts.transport === 'acp') {
      yield* this.streamAcp(facts, options, prompt, cwd, signal)
      return
    }

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
    // `messageText` measures the CLI message being read and `lastText` the whole
    // answer. A partial-message run carries each message's text twice — once as
    // deltas while it is generated, once as the completed message — so a delta
    // is measured against its own message, and the boundary between messages is
    // what keeps the second one from reading as a shortening of the first.
    let messageText = ''
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
      const event = parseCliLine(line, messageText)
      if (event === undefined || event.kind === 'ignored') return false
      if (event.kind === 'message-start') {
        messageText = ''
        return false
      }
      if (event.kind === 'text') {
        if (!blockStarted) {
          blockStarted = true
          queue.push({ type: 'block-start', index: 0, blockType: 'text' })
        }
        messageText += event.delta.text
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

  /**
   * Answer one call through the route's long-lived ACP child. The session owns
   * the conversation, so only this call's text is sent — which is also why the
   * transport pays the CLI's cold start once per route instead of once per call.
   * @param facts - resolved executable facts for this operation.
   * @param options - the model call being answered.
   * @param prompt - the text this call carries.
   * @param cwd - workspace the conversation's session runs in.
   * @param signal - caller cancellation, forwarded as a session cancel.
   * @returns the call's chunks, ending with its terminal.
   */
  private async * streamAcp(
    facts: CliConnectionOptions,
    options: GenerateOptions,
    prompt: string,
    cwd: string,
    signal: AbortSignal | undefined,
  ): AsyncIterable<StreamChunk> {
    const transport = this.acpTransport(facts, options.model)
    // A stateless caller owns no conversation, so its session is a throwaway:
    // reusing one would hand the next title the previous title's history.
    this.statelessCalls += 1
    const key = options.sessionId ?? `stateless:${String(this.statelessCalls)}`
    let session: string
    try {
      session = await transport.sessionFor(key, cwd)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      yield failureChunk(`llm-cli: the CLI session could not be opened: ${message}`, CLI_START_FAILED_CODE, signal)
      return
    }

    let kind: AcpTurnEvent['kind'] | undefined
    let index = -1
    let text = ''
    let reasoning = ''
    try {
      // The CLI reports thinking and answer text as separate streams; a block
      // ends where the next stream takes over, and the last one at the end.
      for await (const event of transport.prompt(session, prompt, signal)) {
        if (kind !== event.kind) {
          if (kind !== undefined) yield { type: 'block-end', index, block: answerBlock(kind, kind === 'text' ? text : reasoning) }
          kind = event.kind
          index += 1
          yield { type: 'block-start', index, blockType: blockTypeOf(kind) }
        }
        if (event.kind === 'text') {
          text += event.text
          yield { type: 'text-delta', index, text: event.text }
        } else {
          reasoning += event.text
          yield { type: 'reasoning-delta', index, text: event.text }
        }
      }
      if (kind !== undefined) yield { type: 'block-end', index, block: answerBlock(kind, kind === 'text' ? text : reasoning) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        yield failureChunk('llm-cli: the CLI run was aborted', 'ABORTED', signal)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      yield failureChunk(`llm-cli: ${message}`, CLI_START_FAILED_CODE, signal)
    }
  }

  /**
   * Release the route's long-lived child, if one was ever started. The plugin
   * calls this from the effect that registered the route, so unloading the
   * route unloads its child rather than leaving it to outlive the composition.
   * @returns once the child's process tree is gone.
   */
  async dispose(): Promise<void> {
    const transport = this.acp?.transport
    this.acp = undefined
    if (transport !== undefined) await transport.dispose()
  }

  /**
   * The ACP connection these facts describe, started on first use and replaced
   * when the facts that started it change. The model rides the process: the CLI
   * takes it as a launch argument, so one child serves one model.
   * @param facts - resolved executable facts for this operation.
   * @param model - model id this call selected.
   * @returns the connection to prompt on.
   */
  private acpTransport(facts: CliConnectionOptions, model: string): AcpTransport {
    const argv = [
      ...facts.acpArgv,
      '--permission-mode', facts.permissionMode,
      ...facts.tools === undefined ? [] : ['--tools', facts.tools],
      ...facts.effort === undefined ? [] : ['--effort', facts.effort],
      '--model', model,
    ]
    const signature = JSON.stringify([argv, facts.cwd, facts.env, facts.disposeGraceMs])
    if (this.acp?.signature === signature) return this.acp.transport
    const previous = this.acp?.transport
    const selectPermission = selectPermissionFor(facts.permissionMode)
    const transport = new AcpTransport({
      spawn: this.spawn,
      argv,
      cwd: facts.cwd,
      env: facts.env,
      graceMs: facts.disposeGraceMs,
      ...selectPermission === undefined ? {} : { selectPermission },
    })
    this.acp = { signature, transport }
    // The replaced child only has its own exit left; the seam owns escalation,
    // and a disposal that fails to observe it is that seam's to report.
    void previous?.dispose().catch(() => undefined)
    return transport
  }
}

/** The block kind one ACP stream reports as, in this seam's vocabulary. */
function blockTypeOf(kind: AcpTurnEvent['kind']): 'text' | 'reasoning' {
  // The CLI calls its reasoning stream "thought"; this seam calls the block it
  // becomes "reasoning", so the two vocabularies meet here and nowhere else.
  return kind === 'text' ? 'text' : 'reasoning'
}

/** The finished block one partial stream leaves behind. */
function answerBlock(kind: AcpTurnEvent['kind'], text: string): ContentBlock {
  return kind === 'text' ? { type: 'text', text } : { type: 'reasoning', text }
}

/**
 * The policy a permission request is answered with. A mode that already lets the
 * CLI run its tools unattended answers with the same intent the CLI's own flag
 * means; every other mode refuses, because approving there would override a
 * policy the deployment chose deliberately.
 * @param mode - the route's permission policy.
 * @returns the selector, or undefined to refuse every request.
 */
function selectPermissionFor(mode: CodeBuddyPermissionMode): AcpTransportOptions['selectPermission'] {
  return mode === 'bypassPermissions' || mode === 'acceptEdits' || mode === 'auto' || mode === 'dontAsk'
    ? options => options.find(option => option.kind === 'allow_always')?.id
      ?? options.find(option => option.kind.startsWith('allow'))?.id
    : undefined
}
