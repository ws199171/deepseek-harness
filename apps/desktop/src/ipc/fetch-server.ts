/**
 * Host side of the desktop IPC carriage. Registers the `dsh:desktop:*`
 * ipcMain channels and feeds every accepted request to
 * `toFetchHandler(api)` — the identical handler the webserver binds — so the
 * desktop renderer and a browser renderer exercise the same wire protocol.
 * The open invoke resolves with the response head (status/headers), and the
 * body of that same response streams back as pushed chunks: a full `Response`
 * cannot cross structured clone, and re-running a unary route for its body
 * would double-execute the business call.
 *
 * IPC ordering matters here: chunk events and the invoke reply travel on
 * independent renderer-side listeners, so a chunk can race ahead of the
 * reply. The headless readout reads the entire response synchronously
 * (buffering in memory — the body of every host API call fits comfortably
 * in a few KiB) and returns it as part of the invoke reply, letting the
 * renderer reconstruct `Response` without crossing the event/reply
 * boundary. This sidesteps the ordering problem entirely: the response
 * body is no longer transported through events at all, so chunks and
 * reply cannot arrive out of order. (SSE streams for `openMux` / `openHost`
 * still use the event carriage; the schema-level invariant is the same —
 * the headless readout only applies to the unary POST path.)
 *
 * Security: only webContents explicitly allowed by the app (the main window)
 * may open or abort fetches; every other sender is rejected or ignored.
 */

import electron, { type WebContents } from 'electron'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'

const { ipcMain } = electron

/** Renderer→main request payload (mirrors `DesktopFetchRequest` on the client half). */
interface DesktopFetchPayload {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * Response head + buffered body returned by the open invoke. The body fits
 * in memory because every host route this carriage serves is a unary POST
 * (a few KiB at most); SSE streams travel on a separate `openStream` route
 * that uses the chunk carriage.
 */
interface DesktopFetchHead {
  id: number
  status: number
  statusText: string
  headers: [string, string][]
  /** Concatenated response body; consumed (and `null` afterwards) once the renderer reads the stream. */
  body: Uint8Array
}

/** IPC channel names, shared by preload and this server (the wire contract). */
const CHANNEL_FETCH = 'dsh:desktop:fetch'
const CHANNEL_ABORT = 'dsh:desktop:abort'

/**
 * Buffer the entire response into a single Uint8Array. The handler is unary
 * (a few KiB at most); SSE routes are intentionally not opened through this
 * channel — they would need a separate streaming carriage.
 */
async function bufferResponse(response: Response): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0)
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/**
 * The desktop fetch server: an ipcMain listener pair (open + abort) over a
 * `toFetchHandler` instance, with per-request abort controllers keyed by
 * stream id and a per-webContents allow-list.
 */
export class DesktopFetchServer {
  private nextId = 1
  private readonly pending = new Map<number, AbortController>()
  private readonly allowed = new Set<number>()
  private readonly handler: { fetch: typeof fetch }
  private registered = false

  constructor(api: ApiProxy) {
    this.handler = toFetchHandler(api)
  }

  /** Allow one webContents (the main window) to use the channel. */
  allow(webContents: WebContents): void {
    this.allowed.add(webContents.id)
  }

  /** Revoke one webContents; its in-flight streams are aborted. */
  disallow(webContents: WebContents): void {
    this.allowed.delete(webContents.id)
    // No per-sender bookkeeping on streams: the desktop app has a single
    // window, so revoking it makes whole-table abort exact.
    for (const controller of this.pending.values()) controller.abort()
    this.pending.clear()
  }

  /** Register the ipcMain channels once; throws on double registration. */
  register(): void {
    if (this.registered) throw new Error('desktop fetch server: already registered')
    this.registered = true
    ipcMain.handle(CHANNEL_FETCH, async (event, payload: DesktopFetchPayload) => {
      if (!this.allowed.has(event.sender.id)) throw new Error('desktop fetch server: unauthorized sender')
      const controller = new AbortController()
      const id = this.nextId++
      this.pending.set(id, controller)
      const request = new Request(payload.url, {
        method: payload.method,
        headers: payload.headers,
        ...(payload.body === undefined ? {} : { body: payload.body }),
        signal: controller.signal,
      })
      const response = await this.handler.fetch(request)
      const body = await bufferResponse(response)
      const head: DesktopFetchHead = {
        id,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
        body,
      }
      return head
    })
    ipcMain.on(CHANNEL_ABORT, (event, payload: { id: number }) => {
      if (!this.allowed.has(event.sender.id)) return
      this.pending.get(payload.id)?.abort()
    })
  }

  /** Dispose the server: abort every in-flight stream (window teardown). */
  dispose(): void {
    for (const controller of this.pending.values()) controller.abort()
    this.pending.clear()
    if (this.registered) ipcMain.removeHandler(CHANNEL_FETCH)
  }
}
