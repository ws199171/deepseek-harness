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
import { AcpTransport, AcpTurnTimeoutError } from './acp.ts'
import type { AcpPromptOutcome, AcpSessionLease, AcpTransportOptions, AcpTurnEvent } from './acp.ts'
import { parseCliLine } from './wire.ts'
import { conversationRecap, flattenConversation, systemTextOf, trailingUserText } from './translate.ts'

/** One optional model entry the CLI route advertises. */
export interface CliCatalogModel {
  /** Model id accepted by {@link GenerateOptions.model} for this route. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /**
   * Input capacity this id accepts, when the deployment knows it. Compaction and
   * switching need it, and a route that owns no endpoint cannot derive it; the
   * ACP handshake supplies the CLI's own figure where it reports one.
   */
  contextWindow?: number
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
  /**
   * Ceiling in milliseconds for one delegated `acp` turn, or `0` for none. The
   * CLI runs a whole agent loop inside one call, so without a ceiling a run that
   * never converges holds the turn open for as long as the CLI keeps working.
   */
  turnTimeoutMs: number
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

/** Failure code reported for a turn the CLI cancelled on its own. */
const CLI_TURN_CANCELLED_CODE = 'CLI_TURN_CANCELLED'

/** Failure code reported for a turn the CLI refused to answer. */
const CLI_TURN_REFUSED_CODE = 'CLI_TURN_REFUSED'

/** Failure code reported for a turn that ended for a reason this route cannot name. */
const CLI_TURN_UNKNOWN_CODE = 'CLI_TURN_FAILED'

/** Failure code reported for a delegated turn that outlived its deadline. */
const CLI_TURN_TIMEOUT_CODE = 'CLI_TURN_TIMEOUT'

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
  /**
   * The long-lived ACP connection of each workspace, replaced when what starts
   * its child changes. The CLI takes its workspace from the directory the child
   * starts in rather than from `session/new`, so a workspace needs its own child.
   */
  private readonly acp = new Map<string, { signature: string; transport: AcpTransport }>()
  /**
   * CLI sessions this route opened, by harness conversation. Held here rather
   * than in the transport because a replaced child must be able to resume them:
   * the id names a session in the CLI's own store, not in one child.
   */
  private readonly acpSessions = new Map<string, string>()
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
    const entry = this.options().models.find(candidate => candidate.id === model)
    const contextWindow = entry?.contextWindow
    return Promise.resolve({
      provider,
      id: model,
      name: entry?.name ?? model,
      // Capacity is the one fact a delegated route cannot infer: compaction and
      // a model switch both refuse to guess it, so only a known one is reported.
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
    })
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
      // The CLI's own session owns the history; a call whose session is gone
      // has to carry it, so the prior turns travel beside the newest text.
      const recap = sessionId === undefined ? undefined : conversationRecap(options.messages)
      yield* this.streamAcp(facts, options, prompt, recap, cwd, signal)
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
   * @param recap - the conversation before this call's newest human text, sent
   *   instead of `prompt` when the CLI session is new and holds no history.
   * @param cwd - workspace the conversation's session runs in.
   * @param signal - caller cancellation, forwarded as a session cancel.
   * @returns the call's chunks, ending with its terminal.
   */
  private async * streamAcp(
    facts: CliConnectionOptions,
    options: GenerateOptions,
    prompt: string,
    recap: string | undefined,
    cwd: string,
    signal: AbortSignal | undefined,
  ): AsyncIterable<StreamChunk> {
    const transport = this.acpTransport(facts, options.model, cwd)
    // A stateless caller owns no conversation, so its session is a throwaway:
    // reusing one would hand the next title the previous title's history.
    this.statelessCalls += 1
    const key = options.sessionId ?? `stateless:${String(this.statelessCalls)}`
    let lease: AcpSessionLease
    try {
      // A conversation that outlived this child (restart, model switch) resumes
      // the session the CLI still holds; the lease says whether it did.
      lease = await transport.openSession(key, cwd, this.acpSessions.get(key))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      yield failureChunk(`llm-cli: the CLI session could not be opened: ${message}`, CLI_START_FAILED_CODE, signal)
      return
    }
    this.acpSessions.set(key, lease.sessionId)
    // A session this child just created holds no history, so the call carries
    // it: the newest input stays the last thing the CLI reads.
    const promptText = lease.created && recap !== undefined ? `${recap}\n\nUser: ${prompt}` : prompt
    const session = lease.sessionId

    let kind: AcpTurnEvent['kind'] | undefined
    let index = -1
    let blockText = ''
    try {
      // The CLI reports thinking and answer text as separate streams; a block
      // ends where the next stream takes over, and the last one at the end.
      const events = transport.prompt(session, promptText, signal)
      let step: IteratorResult<AcpTurnEvent, AcpPromptOutcome> = await events.next()
      while (!step.done) {
        const event = step.value
        if (kind !== event.kind) {
          if (kind !== undefined) yield { type: 'block-end', index, block: answerBlock(kind, blockText) }
          kind = event.kind
          blockText = ''
          index += 1
          yield { type: 'block-start', index, blockType: blockTypeOf(kind) }
        }
        blockText += event.text
        if (event.kind === 'text') {
          yield { type: 'text-delta', index, text: event.text }
        } else {
          yield { type: 'reasoning-delta', index, text: event.text }
        }
        step = await events.next()
      }
      if (kind !== undefined) yield { type: 'block-end', index, block: answerBlock(kind, blockText) }
      // The prompt's own result says how the CLI ended the turn. A turn the CLI
      // cancelled — a refused tool call does that — answers with no text, so
      // reporting it as a stop would hand back an empty reply as a success.
      yield finishOfAcpOutcome(step.value, signal)
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        yield failureChunk('llm-cli: the CLI run was aborted', 'ABORTED', signal)
        return
      }
      if (error instanceof AcpTurnTimeoutError) {
        yield failureChunk(`llm-cli: ${error.message}`, CLI_TURN_TIMEOUT_CODE, signal)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      yield failureChunk(`llm-cli: ${message}`, CLI_START_FAILED_CODE, signal)
    }
  }

  /**
   * Release the route's long-lived children, if any were ever started. The
   * plugin calls this from the effect that registered the route, so unloading
   * the route unloads its children rather than leaving them to outlive the
   * composition.
   * @returns once every child's process tree is gone.
   */
  async dispose(): Promise<void> {
    const transports = [...this.acp.values()].map(entry => entry.transport)
    this.acp.clear()
    await Promise.all(transports.map(transport => transport.dispose()))
  }

  /**
   * The ACP connection one workspace runs on, started on first use and replaced
   * when the facts that started it change. The model and the workspace ride the
   * process: the CLI takes both as launch facts, so one child serves one model
   * in one workspace.
   * @param facts - resolved executable facts for this operation.
   * @param model - model id this call selected.
   * @param cwd - workspace the conversation's session runs in.
   * @returns the connection to prompt on.
   */
  private acpTransport(facts: CliConnectionOptions, model: string, cwd: string): AcpTransport {
    const argv = [
      ...facts.acpArgv,
      '--permission-mode', facts.permissionMode,
      ...facts.tools === undefined ? [] : ['--tools', facts.tools],
      // The CLI bounds its own agent loop only when told to: without this it
      // runs as many tool rounds as it likes inside a single model call.
      ...facts.maxTurns === undefined ? [] : ['--max-turns', String(facts.maxTurns)],
      ...facts.effort === undefined ? [] : ['--effort', facts.effort],
      '--model', model,
    ]
    const signature = JSON.stringify([argv, facts.env, facts.disposeGraceMs])
    const existing = this.acp.get(cwd)
    if (existing?.signature === signature) return existing.transport
    const selectPermission = selectPermissionFor(facts.permissionMode)
    const transport = new AcpTransport({
      spawn: this.spawn,
      argv,
      cwd,
      env: facts.env,
      graceMs: facts.disposeGraceMs,
      ...facts.turnTimeoutMs <= 0 ? {} : { turnTimeoutMs: facts.turnTimeoutMs },
      ...selectPermission === undefined ? {} : { selectPermission },
    })
    this.acp.set(cwd, { signature, transport })
    // The replaced child only has its own exit left; the seam owns escalation,
    // and a disposal that fails to observe it is that seam's to report.
    void existing?.transport.dispose().catch(() => undefined)
    return transport
  }
}

/**
 * The terminal this route reports for how the CLI ended one delegated turn. The
 * stop reason is the only thing that separates a turn the CLI abandoned from a
 * short reply, so every reason but a completed turn is reported as a failure.
 * @param outcome - stop reason the CLI reported for the turn.
 * @param signal - caller cancellation, which outranks the CLI's own reason.
 * @returns the terminal chunk for the call.
 */
function finishOfAcpOutcome(outcome: AcpPromptOutcome, signal?: AbortSignal): StreamChunk {
  const detail = outcome.detail === undefined ? '' : ` (${outcome.detail})`
  switch (outcome.stopReason) {
    case 'end_turn':
      return { type: 'finish', reason: { kind: 'stop' } }
    case 'max_tokens':
    case 'max_turn_requests':
    case 'max_turns':
      return { type: 'finish', reason: { kind: 'max-tokens' } }
    case 'cancelled':
      return failureChunk(`llm-cli: the CLI cancelled the turn${detail}`, CLI_TURN_CANCELLED_CODE, signal)
    case 'refusal':
      return failureChunk(`llm-cli: the CLI refused the turn${detail}`, CLI_TURN_REFUSED_CODE, signal)
    default:
      return failureChunk(`llm-cli: the CLI ended the turn with stop reason "${outcome.stopReason}"${detail}`, CLI_TURN_UNKNOWN_CODE, signal)
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
