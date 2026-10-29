/**
 * Host-side CLI model discovery. It runs the configured CLI's own listing
 * command (default `--help`) through the shared subprocess seam and parses the
 * model ids the CLI reports, so the standard Models page can offer the CLI's
 * real catalog without this package owning a remote surface of its own.
 *
 * Every child here goes through the seam, so discovery inherits process-tree
 * termination and environment scrubbing instead of managing a child itself.
 *
 * @module @deepseek-ai/dsh-llm-cli/discovery
 */

import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AcpTransport } from './acp.ts'
import type { CliCatalogModel } from './adapter.ts'

/** The ACP connection a route that speaks ACP can be interrogated over. */
export interface CliAcpDiscovery {
  /** Executable and arguments that start the CLI as a long-lived ACP agent. */
  argv: readonly string[]
  /** Environment entries layered over the seam's base. */
  env: Record<string, string>
  /** Grace in milliseconds for terminating the probe's process tree. */
  graceMs: number
}

/** In-memory stdout cap for one discovery child; a larger listing is not a model catalog. */
const DISCOVERY_OUTPUT_MAX_BYTES = 1024 * 1024

/** One discovery run's inputs, already validated by the resolver. */
export interface CliDiscoveryRequest {
  /** Executable and arguments producing the model listing on stdout. */
  argv: readonly string[]
  /** Working directory for the discovery child. */
  cwd: string
  /** Hard ceiling in milliseconds for the listing child. */
  timeoutMs: number
  /** The route's advisory catalog, offered after the discovered ids. */
  configured: readonly CliCatalogModel[]
  /** The subprocess seam's spawn operation. */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /**
   * The ACP connection to interrogate instead of the listing command, when the
   * route reaches the CLI over ACP: that handshake carries the capacity of each
   * advertised model, which a listing of ids cannot.
   */
  acp?: CliAcpDiscovery | undefined
  /** Caller cancellation, honored beside the timeout. */
  signal?: AbortSignal | undefined
}

/**
 * Parse the model ids a CodeBuddy-style CLI lists for its `--model` option.
 * @param help - the CLI's own help output.
 * @returns the unique ids in the CLI's reported order, without display names.
 */
export function parseCodeBuddyModels(help: string): LlmDiscoveredModel[] {
  const listing = /--model <model>[\s\S]*?Currently supported:\s*\(([^)]*)\)/.exec(help)?.[1]
  if (listing === undefined) return []
  const ids = new Set<string>()
  for (const value of listing.split(',')) {
    const id = value.trim()
    if (id.length > 0) ids.add(id)
  }
  return [...ids].map(id => ({ id }))
}

/** Run the listing child to completion and return its stdout, or undefined when it did not report. */
async function captureListing(request: CliDiscoveryRequest): Promise<string | undefined> {
  // A caller that cancelled before the child existed has nothing to discover.
  if (request.signal?.aborted === true) return undefined
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  const timer = setTimeout(abort, request.timeoutMs)
  timer.unref()
  request.signal?.addEventListener('abort', abort, { once: true })
  try {
    const handle = request.spawn({
      argv: request.argv,
      cwd: request.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: DISCOVERY_OUTPUT_MAX_BYTES }, stderr: 'inherit' },
      graceMs: request.timeoutMs,
      signal: controller.signal,
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) return undefined
    return handle.collected.stdout?.readFrom(0).text
  } catch {
    // A missing executable or an unavailable provider is one outcome here: no
    // ids were discovered, so the route's configured catalog stands alone.
    return undefined
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', abort)
  }
}

/**
 * Interrogate an ACP route for the catalog its handshake reports.
 * @param request - the route's ACP connection, its bounds, and the seam's spawn.
 * @returns the advertised models, or undefined when the CLI never answered.
 */
async function discoverAcpModels(request: CliDiscoveryRequest): Promise<readonly LlmDiscoveredModel[] | undefined> {
  const acp = request.acp
  if (acp === undefined) return undefined
  // A caller that cancelled before the handshake has nothing to discover.
  if (request.signal?.aborted === true) return undefined
  const transport = new AcpTransport({
    spawn: request.spawn,
    argv: acp.argv,
    cwd: request.cwd,
    env: acp.env,
    graceMs: acp.graceMs,
  })
  // Disposal is the only interruption this probe has: it ends the child, whose
  // pending request then rejects into the fallback below.
  const abort = (): void => { void transport.dispose() }
  const timer = setTimeout(abort, request.timeoutMs)
  timer.unref()
  request.signal?.addEventListener('abort', abort, { once: true })
  try {
    return await transport.describeModels(request.cwd)
  } catch {
    // A CLI that cannot answer the handshake is the listing command's case; the
    // caller falls back to it rather than reporting a discovery failure.
    return undefined
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', abort)
    await transport.dispose()
  }
}

/**
 * Discover the models the configured CLI advertises.
 * @param request - the listing invocation, its bounds, and the route's own catalog.
 * @returns the discovered models first, then configured ids the CLI did not report.
 */
export async function discoverCliModels(request: CliDiscoveryRequest): Promise<readonly LlmDiscoveredModel[]> {
  // A route with no ACP connection must not pay for a microtask before it
  // starts its listing child: the caller's cancellation window opens with the
  // call itself, and an early abort has to reach the child it already spawned.
  const advertised = request.acp === undefined ? undefined : await discoverAcpModels(request)
  const help = advertised === undefined || advertised.length === 0
    ? await captureListing(request)
    : undefined
  const discovered = advertised !== undefined && advertised.length > 0
    ? [...advertised]
    : help === undefined ? [] : parseCodeBuddyModels(help)
  const seen = new Set(discovered.map(model => model.id))
  const models: LlmDiscoveredModel[] = [...discovered]
  for (const model of request.configured) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    models.push({
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    })
  }
  return models
}
