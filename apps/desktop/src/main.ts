/**
 * dsh desktop shell — Electron main process (M2, the in-process form).
 *
 * The host no longer runs as a child process: this process boots the `web`
 * profile through the CLI's `runProfile` (the same entry `dsh web` uses) and
 * owns the resulting cordis tree. The renderer talks to it over the IPC
 * bridge (`DesktopFetchServer` → `toFetchHandler(ctx.apiProxy)`), the same
 * wire protocol the webserver binds; the webserver still serves the frontend
 * dist (M2b moves that to file://). Closing the window disposes the host
 * tree through the profile's bounded shutdown.
 *
 * Note on the launch path: `runProfile` resolves its `INSTALL_ANCHOR`
 * (apps/cli/package.json) from `import.meta.url`; the only path that lands
 * on a real package.json is the CLI source tree, reachable through tsx's
 * ESM hook (the launching shell sets `NODE_OPTIONS=--import=tsx/esm`). The
 * same constraint the source `pnpm dsh web` follows (see .agents/notes
 * dsh-source-launch-tsx-esm).
 */

import electron, { type BrowserWindow as BrowserWindowType } from 'electron'
import { join } from 'node:path'
import { DesktopFetchServer } from './ipc/fetch-server.ts'
import { findRepoRoot } from './resolver.ts'

const { app, BrowserWindow, dialog } = electron

/** Window geometry for the single window. */
const WINDOW_OPTIONS = {
  width: 1280,
  height: 840,
  title: 'DeepSeek Harness',
  webPreferences: {
    preload: join(app.getAppPath(), 'lib', 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
} as const

/** The shutdown handle returned by `runProfile`. */
interface HostShutdown {
  shutdown(code: number): Promise<void>
}

/** The shape of the host boot result the shell needs (the rest stays internal to the CLI). */
interface HostBoot {
  ctx: { get(name: string): { port?: number } | undefined; apiProxy: unknown }
  shutdown: HostShutdown
}

let host: HostShutdown | undefined
let server: DesktopFetchServer | undefined
let mainWindow: BrowserWindowType | undefined
let quitting = false

/** Report a fatal launch failure and exit (before any window exists). */
function failLaunch(message: string): void {
  dialog.showErrorBox('DeepSeek Harness', message)
  quitting = true
  app.quit()
}

/** One-window create: wire the load-failure and closed paths. */
function createWindow(url: string): BrowserWindowType {
  const window = new BrowserWindow(WINDOW_OPTIONS)
  mainWindow = window
  window.on('closed', () => { mainWindow = undefined })
  window.webContents.on('did-fail-load', (_event, code, description) => {
    if (quitting) return
    dialog.showErrorBox('DeepSeek Harness', `The UI failed to load (${code}): ${description}`)
    quitting = true
    app.quit()
  })
  void window.loadURL(url)
  return window
}

/**
 * Dynamic-import the CLI source through tsx's ESM hook. The hook is the
 * main process's loader (set by `NODE_OPTIONS`), so `.ts` paths are
 * resolved normally; this keeps `INSTALL_ANCHOR` pointed at the real
 * `apps/cli/package.json`.
 * @returns the live `runProfile` and `loadLayeredEnv` functions.
 */
async function loadCliModules(): Promise<{
  runProfile: (options: unknown) => Promise<HostBoot>
  loadLayeredEnv: (name: string) => unknown
}> {
  const repoRoot = findRepoRoot(app.getAppPath())
  if (repoRoot === undefined) {
    throw new Error('desktop shell: cannot find the repository root (no pnpm-workspace.yaml above the app path)')
  }
  const profileBootPath = join(repoRoot, 'apps/cli/src/profile-boot.ts')
  const appBootPath = join(repoRoot, 'packages/boot/app-boot/src/index.ts')
  // Both modules export a default-free surface: `runProfile` and
  // `loadLayeredEnv`. The dynamic import returns a namespace object whose
  // fields match those exports; we narrow with a structural cast.
  const profileBoot = (await import(profileBootPath)) as { runProfile: (options: unknown) => Promise<HostBoot> }
  const appBoot = (await import(appBootPath)) as { loadLayeredEnv: (name: string) => unknown }
  return { runProfile: profileBoot.runProfile, loadLayeredEnv: appBoot.loadLayeredEnv }
}

// ---- App lifecycle ----

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    try {
      const { runProfile, loadLayeredEnv } = await loadCliModules()
      const boot = await runProfile({
        environment: loadLayeredEnv('dsh'),
        profile: 'web',
        patchFiles: [],
        args: [],
      })
      host = boot.shutdown
      // The web profile always carries the webserver + apiProxy rows; a
      // missing one means the composition changed under the desktop shell.
      const port = boot.ctx.get('webServer')?.port
      if (port === undefined) throw new Error('desktop shell: webServer service missing from the web profile')
      server = new DesktopFetchServer(boot.ctx.apiProxy as never)
      server.register()
      const window = createWindow(`http://127.0.0.1:${String(port)}`)
      server.allow(window.webContents)
    } catch (error) {
      failLaunch(`The dsh host failed to start:\n${error instanceof Error ? error.message : String(error)}`)
    }
  })

  app.on('before-quit', (event) => {
    if (quitting || host === undefined) return
    // First pass: hold the quit, dispose the IPC server and the host tree
    // through the profile's bounded shutdown, then exit for real.
    event.preventDefault()
    quitting = true
    server?.dispose()
    void host.shutdown(0).then(() => { app.exit(0) })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
