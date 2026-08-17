/**
 * Path resolution for the desktop shell: the Electron main process cannot
 * assume a shell PATH (macOS GUI launches inherit a minimal environment),
 * but more importantly it must locate the repository root so it can run the
 * CLI source tree through tsx's ESM hook — the only path the `INSTALL_ANCHOR`
 * path constant in `runProfile` resolves correctly.
 *
 * Resolution: `pnpm-workspace.yaml` is the marker the dsh repo always
 * carries; we walk up from `app.getAppPath()` until we find it.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Find the repository root by walking up from a start directory until a
 * `pnpm-workspace.yaml` is found.
 * @param start - directory to walk up from (typically `app.getAppPath()`).
 * @returns the repository root, or undefined when the marker is absent.
 */
export function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return undefined
    dir = parent
  }
}
