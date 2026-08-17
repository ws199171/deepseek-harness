/**
 * Desktop (Electron) IPC carrier for the connection client half. The
 * Electron preload exposes a structured-clone-safe bridge as
 * `window.__DSH_DESKTOP__`; this module types that bridge, detects it, and
 * implements the `AbstractApiClient` transport aspect over it. The host side
 * of the channel is the desktop shell's fetch server
 * (`apps/desktop/src/ipc/fetch-server.ts`), which feeds every request to
 * `toFetchHandler(api)` — the same handler the webserver binds, so the wire
 * protocol (paths, envelopes, SSE framing) is identical; only the carriage
 * changes from HTTP to IPC.
 *
 * Browser-safe by construction: no Node imports, no Electron imports — the
 * bridge is a plain global object, so this module also loads harmlessly in a
 * browser (detection simply finds nothing).
 *
 * Transport note: the current carriage is headless — the host buffers the
 * response body and returns it inside the invoke reply, so chunks never race
 * the reply across the event/reply boundary. The body still travels through
 * a `ReadableStream` here (a single `enqueue(body)` followed by `close()`)
 * so every consumer — `response.json()`, `response.body.getReader()`,
 * `text()` — works identically to HTTP.
 */

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'

/** Renderer→main fetch request (structured-clone-safe: string body only). */
export interface DesktopFetchRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * Response head returned by the main-side open call. The body travels in
 * the same invoke reply (no separate chunk carriage), which sidesteps
 * ordering races between event-stream chunks and the invoke's reply.
 */
export interface DesktopFetchHead {
  id: number
  status: number
  statusText: string
  headers: [string, string][]
  body: Uint8Array
}

/**
 * The preload-exposed bridge shape. Only structured-clone-safe values cross
 * (plain records, strings, Uint8Array chunks).
 */
export interface DesktopIpcBridge {
  /** Open one fetch on the host side; resolves with the head + body. */
  openFetch(payload: DesktopFetchRequest): Promise<DesktopFetchHead>
  /**
   * Abort a host-side request by id. Forward-compatibility for a future
   * streaming carriage — the headless carriage completes within the openFetch
   * reply, so no mid-stream cancellation is currently needed.
   */
  abort(id: number): void
}

/** Name the preload exposes the bridge under (`contextBridge.exposeInMainWorld`). */
const DESKTOP_BRIDGE_KEY = '__DSH_DESKTOP__'

/**
 * Read the preload-exposed bridge, if the page runs inside the desktop shell.
 * @returns the bridge, or undefined in a plain browser (or jsdom).
 */
export function desktopIpcBridge(): DesktopIpcBridge | undefined {
  const bridge = (globalThis as { __DSH_DESKTOP__?: DesktopIpcBridge })[DESKTOP_BRIDGE_KEY]
  return bridge
}

/** Frame the abort-side error with the same message fetch uses. */
function abortError(): Error {
  return new Error('This operation was aborted')
}

/**
 * Desktop IPC api client: the only transport aspect is {@link doFetch},
 * which wraps the headless reply in a `Response` whose body is the buffered
 * `Uint8Array`. Every protocol invariant (envelopes, SSE framing, rpcId
 * minting) stays in {@link AbstractApiClient}.
 */
export class IpcApiClient extends AbstractApiClient {
  constructor(
    private readonly bridge: DesktopIpcBridge,
    timeoutMs?: number,
  ) {
    super(timeoutMs)
  }

  protected async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const bridge = this.bridge
    const headers: Record<string, string> = {}
    const initHeaders = new Headers(init?.headers)
    initHeaders.forEach((value, key) => { headers[key] = value })
    const body = typeof init?.body === 'string' ? init.body : undefined
    const head = await bridge.openFetch({
      url: input.href,
      method: init?.method ?? 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
    })

    const signal = init?.signal
    if (signal?.aborted) {
      bridge.abort(head.id)
      throw abortError()
    }

    // The body is already fully buffered on the host side; deliver it as a
    // single-chunk stream. A one-shot `enqueue` + `close` cannot race with
    // any consumer cancel because there are no further pulls.
    let closed = false
    const buffered = head.body
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (closed) return
        closed = true
        if (buffered.byteLength > 0) {
          try { controller.enqueue(buffered) } catch { /* reader canceled */ }
        }
        try { controller.close() } catch { /* already closed */ }
      },
      cancel() {
        closed = true
      },
    })

    return new Response(stream, { status: head.status, statusText: head.statusText, headers: head.headers })
  }
}
