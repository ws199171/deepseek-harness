/**
 * Project-root discovery and manifest probing.
 *
 * Both functions are written against a structural filesystem provider rather
 * than an import: the plugin reads it from `ctx.get('fs')`, so a deployment
 * without a filesystem provider simply contributes nothing instead of reaching
 * around the sandbox with `node:fs`. Tests supply their own adapter.
 *
 * @module dsh-context-ledger/root
 */

import { dirname, join, resolve } from 'node:path'

/**
 * The filesystem capability this module needs, and no more.
 *
 * Narrowing the seam to the two methods actually called keeps a test adapter
 * small and states the contract precisely: resolve a host path to a provider
 * target, then describe that target. The target is a type parameter rather than
 * `unknown` because `stat` takes it back as a parameter, so an opaque target
 * would not be assignable from the real provider. `ctx.fs` satisfies
 * `PathProbeFileSystem<FsTarget>` structurally, and a test adapter can use a
 * plain string.
 *
 * @typeParam TTarget - The provider's own target representation.
 */
export interface PathProbeFileSystem<TTarget = string> {
  /**
   * Map a host path to a provider target.
   *
   * @param path - Absolute host path.
   * @param options - Cancellation for the lookup.
   * @returns The provider's target for that path.
   */
  resolve: (path: string, options?: { signal?: AbortSignal }) => Promise<TTarget>
  /**
   * Describe a provider target.
   *
   * @param target - A target from {@link PathProbeFileSystem.resolve}.
   * @param signal - Cancellation for the lookup.
   * @returns File metadata, or `undefined` when the path does not exist.
   */
  stat: (target: TTarget, signal?: AbortSignal) => Promise<{ version?: string; size?: number } | undefined>
}

/** One manifest's presence at the project root. */
export interface ManifestProbe {
  /** The manifest's configured name, e.g. `package.json`. */
  readonly name: string
  /** Whether the manifest exists at the project root. */
  readonly present: boolean
  /** Byte size when the provider reports one. */
  readonly size?: number | undefined
  /** Provider change token when it reports one. */
  readonly version?: string | undefined
}

/** What probing one path established. */
export interface PathProbe {
  /** Whether the path exists. */
  readonly present: boolean
  /** Byte size when the provider reports one. */
  readonly size?: number | undefined
  /** Provider change token when it reports one. */
  readonly version?: string | undefined
}

/** Wrap an optional signal the way the filesystem provider expects it. */
function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

/**
 * Probe one path through the provider.
 *
 * A rejected `stat` propagates: a permission failure or an unreachable host is a
 * fact the caller decides how to report, not something to silently read as
 * "absent". The caller in `index.ts` logs it and contributes nothing.
 *
 * @param fileSystem - The provider from `ctx.get('fs')`.
 * @param path - Absolute host path to probe.
 * @param signal - Cancellation for the provider calls.
 * @returns The probe outcome.
 */
export async function probePath<TTarget>(
  fileSystem: PathProbeFileSystem<TTarget>,
  path: string,
  signal: AbortSignal | undefined,
): Promise<PathProbe> {
  const target = await fileSystem.resolve(path, signalOptions(signal))
  const info = await fileSystem.stat(target, signal)
  if (info === undefined) return { present: false }
  return {
    present: true,
    ...info.size === undefined ? {} : { size: info.size },
    ...info.version === undefined ? {} : { version: info.version },
  }
}

/**
 * Walk upward to the first directory containing a configured root marker.
 *
 * Unlike the first-party loader's equivalent, this reports a marker miss
 * explicitly instead of returning the starting directory. A bare directory with
 * no marker is not a project, and presenting one as a project would make the
 * identity block assert something untrue.
 *
 * @param request - The walk request.
 * @param request.cwd - Absolute session working directory where the walk begins.
 * @param request.markers - Child names that identify a project root.
 * @param request.fileSystem - The provider from `ctx.get('fs')`.
 * @param request.signal - Cancellation for the provider calls.
 * @returns The discovered root, and whether a marker was found.
 */
export async function findProjectRoot<TTarget>(request: {
  cwd: string
  markers: readonly string[]
  fileSystem: PathProbeFileSystem<TTarget>
  signal: AbortSignal | undefined
}): Promise<{ root: string; hasMarker: boolean }> {
  const { cwd, markers, fileSystem, signal } = request
  const start = resolve(cwd)
  let current = start
  for (;;) {
    for (const marker of markers) {
      const probe = await probePath(fileSystem, join(current, marker), signal)
      if (probe.present) return { root: current, hasMarker: true }
    }
    const parent = dirname(current)
    if (parent === current) return { root: start, hasMarker: false }
    current = parent
  }
}

/**
 * Probe every configured manifest at the project root.
 *
 * Probes run concurrently: they are independent reads of sibling paths, and the
 * walk above has already established that the root exists.
 *
 * @param request - The probe request.
 * @param request.projectRoot - Directory holding the manifests.
 * @param request.names - Manifest file names to probe.
 * @param request.fileSystem - The provider from `ctx.get('fs')`.
 * @param request.signal - Cancellation for the provider calls.
 * @returns One probe per named manifest, in the configured order.
 */
export async function probeManifests<TTarget>(request: {
  projectRoot: string
  names: readonly string[]
  fileSystem: PathProbeFileSystem<TTarget>
  signal: AbortSignal | undefined
}): Promise<ManifestProbe[]> {
  const { projectRoot, names, fileSystem, signal } = request
  return Promise.all(names.map(async (name) => {
    const probe = await probePath(fileSystem, join(projectRoot, name), signal)
    return {
      name,
      present: probe.present,
      ...probe.size === undefined ? {} : { size: probe.size },
      ...probe.version === undefined ? {} : { version: probe.version },
    }
  }))
}
