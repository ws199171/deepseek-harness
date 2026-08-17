/**
 * Desktop shell preload: the only surface that crosses contextIsolation. It
 * exposes the IPC bridge as `window.__DSH_DESKTOP__`, which the connection
 * client half detects (`desktopIpcBridge()` in dsh-client-connection) to
 * select the IPC carrier over HTTP. Sandboxed preload: only `electron`'s
 * contextBridge/ipcRenderer are imported.
 *
 * Channel contract (the renderer-side shape is `DesktopIpcBridge` in
 * dsh-client-connection; the host side is `apps/desktop/src/ipc/fetch-server.ts`):
 * - invoke `dsh:desktop:fetch` {url, method, headers, body?} → head {id, status, statusText, headers, body}
 * - send `dsh:desktop:abort` {id} (forward-compatibility for future streaming carriage)
 *
 * The current carriage is headless (body returned in the invoke reply, no
 * event-stream chunks); the response is small enough to fit comfortably in
 * memory for every unary host route the renderer calls. SSE streams on the
 * `openMux` / `openHost` paths will travel on a separate carriage if the
 * profile composes them; today, the desktop shell uses HTTP+SSE for those
 * (the webserver row is still part of the in-process host).
 */

import { contextBridge, ipcRenderer } from 'electron'

/** Names the exposed global (matched by `desktopIpcBridge()`). */
const DESKTOP_BRIDGE_KEY = '__DSH_DESKTOP__'

const bridge = {
  openFetch: (payload: unknown) => ipcRenderer.invoke('dsh:desktop:fetch', payload),
  abort: (id: number) => { ipcRenderer.send('dsh:desktop:abort', { id }) },
}

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge)
