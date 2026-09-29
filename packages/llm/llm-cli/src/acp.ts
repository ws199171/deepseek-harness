/**
 * ACP transport: one long-lived CLI child that carries every delegated run of a
 * route, driven over the Agent Client Protocol (NDJSON on stdin and stdout).
 *
 * The print transport starts a child per model call, so every call pays the
 * CLI's cold start and the answer can only be read from that one run. This
 * transport starts the child once, handshakes, and maps each model call to a
 * `session/prompt` on the session its conversation owns; the answer arrives as
 * `session/update` notifications, which is also where the CLI's own thinking
 * becomes visible instead of staying inside the child.
 *
 * The child is addressed by JSON-RPC framing: requests carry an id this module
 * correlates, notifications carry a session id it routes, and a request the CLI
 * raises for itself — a tool permission — is answered by the configured policy
 * rather than left hanging, because an unanswered request stalls the turn.
 *
 * @module @deepseek-ai/dsh-llm-cli/acp
 */

import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Protocol revision this client speaks; the CLI answers with its own. */
const PROTOCOL_VERSION = 1

/** One incremental piece of a delegated answer. */
export type AcpTurnEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }

/** One permission option the CLI offers for a tool call it wants to run. */
export interface AcpPermissionOption {
  /** Identifier the answer selects. */
  id: string
  /** Protocol-level kind, which is what a policy answers in terms of. */
  kind: string
}

/** What the transport needs to run one route's child. */
export interface AcpTransportOptions {
  /** The subprocess seam's spawn operation. */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Executable and ACP arguments; a prompt never rides argv here. */
  argv: readonly string[]
  /** Working directory the child itself starts in. */
  cwd: string
  /** Environment entries layered over the seam's base. */
  env: Record<string, string>
  /** Grace in milliseconds for child process-tree termination. */
  graceMs: number
  /**
   * Answer one permission request: the option id to select, or undefined to
   * refuse. Absent refuses every request, which is what a deployment that
   * expects no tool activity wants.
   */
  selectPermission?: (options: readonly AcpPermissionOption[]) => string | undefined
}

/** A buffered consumer of one turn's events. */
class TurnBuffer {
  private readonly events: AcpTurnEvent[] = []
  private waiter: (() => void) | undefined
  private ended = false
  private failure: Error | undefined

  /** Append one event and wake a waiting consumer. */
  push(event: AcpTurnEvent): void {
    this.events.push(event)
    this.wake()
  }

  /** End the turn without an error. */
  end(): void {
    this.ended = true
    this.wake()
  }

  /** End the turn with the failure the caller must not lose. */
  fail(error: Error): void {
    this.failure ??= error
    this.ended = true
    this.wake()
  }

  /** Wait for the next event, or undefined once the turn ended and drained. */
  async shift(): Promise<AcpTurnEvent | undefined> {
    while (this.events.length === 0) {
      if (!this.ended) {
        await new Promise<void>((resolve) => { this.waiter = resolve })
        continue
      }
      if (this.failure !== undefined) throw this.failure
      return undefined
    }
    return this.events.shift()
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }
}

/** One outgoing request awaiting its response. */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Narrow a parsed JSON value to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** The text one `session/update` carries, when it carries any. */
function updateEventOf(update: Record<string, unknown>): AcpTurnEvent | undefined {
  const kind = update.sessionUpdate
  if (kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk') return undefined
  const content = asRecord(update.content)
  const text = content?.text
  if (typeof text !== 'string' || text.length === 0) return undefined
  return kind === 'agent_message_chunk' ? { kind: 'text', text } : { kind: 'thought', text }
}

/** The permission options one request offers, in the CLI's own order. */
function permissionOptionsOf(params: Record<string, unknown>): AcpPermissionOption[] {
  const options = params.options
  if (!Array.isArray(options)) return []
  const parsed: AcpPermissionOption[] = []
  for (const option of options) {
    const record = asRecord(option)
    if (record === undefined) continue
    const id = record.optionId ?? record.id
    if (typeof id !== 'string' || id.length === 0) continue
    parsed.push({ id, kind: typeof record.kind === 'string' ? record.kind : '' })
  }
  return parsed
}

/**
 * One route's long-lived ACP connection.
 *
 * A transport is started lazily on first use and lives until {@link dispose};
 * sessions are created per harness conversation and reused across its calls,
 * so a second call to the same conversation pays neither a cold start nor a
 * handshake.
 */
export class AcpTransport {
  private child: SubprocessHandle | undefined
  private starting: Promise<void> | undefined
  private buffer = ''
  private nextId = 1
  private disposed = false
  private readonly pending = new Map<number, PendingRequest>()
  private readonly turns = new Map<string, TurnBuffer>()
  private readonly sessions = new Map<string, string>()

  constructor(private readonly options: AcpTransportOptions) {}

  /**
   * The ACP session one conversation is bound to, created on first use.
   * @param key - the harness conversation this session belongs to.
   * @param cwd - workspace the session runs in.
   * @returns the session id.
   */
  async sessionFor(key: string, cwd: string): Promise<string> {
    const existing = this.sessions.get(key)
    if (existing !== undefined) return existing
    await this.ensureStarted()
    const created = await this.request('session/new', { cwd, mcpServers: [] })
    const sessionId = asRecord(created)?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('llm-cli: the CLI created no session for this conversation')
    }
    this.sessions.set(key, sessionId)
    return sessionId
  }

  /**
   * Run one model call as a prompt on the session that owns the conversation.
   * @param sessionId - the ACP session from {@link sessionFor}.
   * @param text - the prompt text this call carries.
   * @param signal - caller cancellation, forwarded as `session/cancel`.
   * @returns the answer's incremental events, ending when the turn ends.
   */
  async * prompt(sessionId: string, text: string, signal?: AbortSignal): AsyncIterable<AcpTurnEvent> {
    await this.ensureStarted()
    if (signal?.aborted === true) throw new Error('llm-cli: the request was aborted before the turn started')
    const turn = new TurnBuffer()
    this.turns.set(sessionId, turn)
    const cancel = (): void => { this.notify('session/cancel', { sessionId }) }
    signal?.addEventListener('abort', cancel, { once: true })
    const response = this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
      .then(() => { turn.end() })
      .catch((error: unknown) => {
        turn.fail(error instanceof Error ? error : new Error(String(error)))
      })
    try {
      for (;;) {
        const event = await turn.shift()
        if (event === undefined) break
        yield event
      }
      await response
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (this.turns.get(sessionId) === turn) this.turns.delete(sessionId)
    }
  }

  /**
   * End the connection and the child behind it.
   * @returns once the child's process tree is gone.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    this.child = undefined
    this.failAll(new Error('llm-cli: the ACP connection was disposed'))
    if (child === undefined) return
    child.terminate()
    await child.done.catch(() => undefined)
  }

  /** Start the child and handshake once; a second caller joins the first attempt. */
  private async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error('llm-cli: the ACP connection was disposed')
    this.starting ??= this.start()
    await this.starting
  }

  private async start(): Promise<void> {
    const { argv, cwd, graceMs, env, spawn } = this.options
    const child = spawn({
      argv: [...argv],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs,
      env,
    })
    this.child = child
    const stdout = child.stdout
    if (stdout === undefined) throw new Error('llm-cli: the ACP child has no stdout to read from')
    stdout.on('data', (data: Buffer) => {
      this.buffer += data.toString('utf8')
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline === -1) break
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        this.handleLine(line)
      }
    })
    child.done.then(
      () => { this.failAll(new Error('llm-cli: the ACP child exited')) },
      (error: unknown) => { this.failAll(error instanceof Error ? error : new Error(String(error))) },
    )
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
  }

  /** Route one parsed line: a response, a turn update, or a request to answer. */
  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // A diagnostic on stdout is outside the protocol and carries no routing.
      return
    }
    const message = asRecord(parsed)
    if (message === undefined) return
    const id = message.id
    if (typeof id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      if (message.error !== undefined) {
        const detail = asRecord(message.error)?.message
        pending.reject(new Error(typeof detail === 'string' ? detail : 'llm-cli: the CLI refused a request'))
        return
      }
      pending.resolve(message.result)
      return
    }
    const params = asRecord(message.params)
    if (message.method === 'session/update' && params !== undefined) {
      const sessionId = params.sessionId
      const update = asRecord(params.update)
      if (typeof sessionId !== 'string' || update === undefined) return
      const event = updateEventOf(update)
      if (event !== undefined) this.turns.get(sessionId)?.push(event)
      return
    }
    if (typeof id === 'number' && typeof message.method === 'string') this.answerRequest(id, message.method, params ?? {})
  }

  /** Answer one request the CLI raised, so the turn it belongs to can continue. */
  private answerRequest(id: number, method: string, params: Record<string, unknown>): void {
    if (method === 'session/request_permission') {
      const selected = this.options.selectPermission?.(permissionOptionsOf(params))
      this.write({
        jsonrpc: '2.0',
        id,
        result: selected === undefined
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId: selected } },
      })
      return
    }
    // Capabilities this client did not declare: refuse rather than stall.
    this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported request ${method}` } })
  }

  /** Send one request and await its response. */
  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) throw new Error('llm-cli: the ACP connection was disposed')
    const id = this.nextId
    this.nextId += 1
    const answered = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return answered
  }

  /** Send one notification, which expects no answer. */
  private notify(method: string, params: Record<string, unknown>): void {
    if (this.disposed) return
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(message: Record<string, unknown>): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  /** Fail every waiter: the child is gone, so no request can be answered. */
  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const turn of this.turns.values()) turn.fail(error)
    this.turns.clear()
  }
}
