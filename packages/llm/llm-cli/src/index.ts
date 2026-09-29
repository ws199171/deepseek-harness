/**
 * `llm-cli`: a provider route answered by a CLI child instead of a provider HTTP
 * endpoint.
 *
 * The route exists so a deployment can run the harness with no API key at all:
 * the configured CLI (CodeBuddy by default) carries its own authentication and
 * runs its own agentic loop with its own tools. The harness forwards
 * conversation text and receives the final answer, so a model swap is a
 * configuration change rather than a harness change.
 *
 * The plugin depends on exactly two seams — `llm` (the adapter registry) and
 * `subprocess` (child lifecycle) — and reaches the session store, when a
 * deployment has one, through an untyped service lookup. Nothing here requires
 * `dsh-session`, a remote surface, or a client package, so mounting it changes
 * no shared package.
 *
 * ```yaml
 * - id: llm-cli
 *   name: '@deepseek-ai/dsh-llm-cli'
 *   config:
 *     command: codebuddy
 *     args: ['--print', '--output-format', 'stream-json', '--include-partial-messages']
 *     permissionMode: bypassPermissions
 * ```
 *
 * @module @deepseek-ai/dsh-llm-cli
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import type { GenerateOptions, LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { CliAdapter } from './adapter.ts'
import type { CliCatalogModel } from './adapter.ts'
import { Config, mergeCatalog, plainOptions, resolveAdapterOptions } from './config.ts'
import type { Options, ResolvedCliOptions } from './config.ts'
import { discoverCliModels } from './discovery.ts'

export {
  CliAdapter,
  CLI_TRANSPORTS,
  CODEBUDDY_EFFORT_LEVELS,
  CODEBUDDY_PERMISSION_MODES,
  DEFAULT_TRANSPORT,
} from './adapter.ts'
export type {
  CliAdapterOptions,
  CliCatalogModel,
  CliConnectionOptions,
  CliTransport,
  CodeBuddyEffort,
  CodeBuddyPermissionMode,
} from './adapter.ts'
export { AcpTransport } from './acp.ts'
export type { AcpPermissionOption, AcpTransportOptions, AcpTurnEvent } from './acp.ts'
export {
  Config,
  DEFAULT_ARGS,
  DEFAULT_COMMAND,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_MODEL_DISCOVERY_ARGS,
  DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_SESSION_ID_ARG,
  plainOptions,
  resolveAdapterOptions,
} from './config.ts'
export type { Options, ResolvedCliOptions } from './config.ts'
export { discoverCliModels, parseCodeBuddyModels } from './discovery.ts'
export * from './translate.ts'
export * from './wire.ts'

export const name = 'llm-cli'
export const inject = ['llm', 'subprocess']

/** The single provider route this plugin owns; a registration-time fact. */
const PROVIDER = 'codebuddy-cli'
/** Human-readable provider name for selectors. */
const DISPLAY_NAME = 'CodeBuddy CLI'

/** Minimal dynamic view of the session store, so this package needs no `dsh-session` dependency. */
interface SessionCwdSource {
  get(sessionId: NonNullable<GenerateOptions['sessionId']>): { readonly header: { readonly cwd?: string } } | undefined
}

/** Register the CLI route, its settings section, and its model discovery. */
export function apply(ctx: Context, config: Config): void {
  // The Models page owns this route's presentation, so the entry gets no
  // auto-generated settings form of its own.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // The entry id is the settings namespace: that is what a configuration
  // surface already holds from the configurable-provider directory.
  const settingsNs = ctx.fiber.entry?.options.id ?? name

  /**
   * Model entries the CLI last advertised. The picker reads this route's
   * catalog through `listModels`, so the CLI's own listing has to reach the
   * resolved facts; discovery is best-effort, and an unreachable CLI leaves the
   * configured catalog standing alone.
   */
  let advertised: readonly CliCatalogModel[] = []

  /**
   * Executable facts for the current configuration, re-resolved per operation
   * so a settings edit reaches the very next request without re-registering the
   * route. Nothing about this route is captured at registration time — the
   * provider id, its display name, and the settings namespace are all create-once
   * facts — so a volatile update needs no reload hook of its own: the loader
   * commits a snapshot only after {@link apply}'s `internal/config` listener has
   * accepted it, which is why a resolve here can no longer fail.
   */
  const options = (): ResolvedCliOptions => {
    const current = plainOptions(config)
    return resolveAdapterOptions(
      { ...current, models: mergeCatalog(current.models ?? [], advertised) },
      process.cwd(),
    )
  }
  // Fail loud at load for a broken composition entry.
  options()

  /**
   * Probe the CLI for the models it advertises and remember them for this
   * route, so a picker offers the CLI's real ids instead of an empty list.
   * @param signal - caller cancellation, honored beside the discovery bound.
   * @returns the advertised ids, declared entries the CLI did not report last.
   */
  const probeCatalog = async (signal?: AbortSignal): Promise<readonly LlmDiscoveredModel[]> => {
    const current = plainOptions(config)
    const facts = resolveAdapterOptions(current, process.cwd())
    const models = await discoverCliModels({
      argv: facts.discoveryArgv,
      cwd: facts.cwd,
      timeoutMs: facts.discoveryTimeoutMs,
      configured: current.models ?? [],
      spawn: spec => ctx.subprocess.spawn(spec),
      ...signal === undefined ? {} : { signal },
    })
    advertised = models.map(model => (model.name === undefined ? { id: model.id } : { id: model.id, name: model.name }))
    return models
  }
  // One probe per composition, rather than only when a Models page asks: the
  // listing is what makes a model selectable in the first place.
  void probeCatalog().catch((error: unknown) => {
    // Discovery reports a child that never reported as an empty catalog; a
    // rejection here is the probe itself failing, and the configured list stands.
    ctx.logger.warn('llm-cli: model discovery failed: %s', error instanceof Error ? error.message : String(error))
  })

  // A settings write is judged where it lands, so the Models page reports an
  // unusable section instead of the next request failing mysteriously. The
  // loader runs this waterfall before it commits a volatile snapshot, so a
  // refusal here is what keeps every later resolve succeeding.
  ctx.on('internal/config', function (this: Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    resolveAdapterOptions(plainOptions(Config(raw as Options)), process.cwd())
    return raw
  })

  const adapter = new CliAdapter({
    options,
    spawn: spec => ctx.subprocess.spawn(spec),
    // Scoped to a lookup rather than an injection: a composition without the
    // session service simply runs the CLI in the configured working directory.
    resolveSessionCwd: sessionId => (ctx.get('sessions') as SessionCwdSource | undefined)?.get(sessionId)?.header.cwd,
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)
  // The ACP transport keeps a child alive for the route's lifetime, so unloading
  // the route has to end that child with it.
  ctx.effect(() => () => adapter.dispose())

  // Offered for the whole namespace rather than per route: the Models page
  // interrogates the CLI itself, and a CLI has no endpoint to name. An
  // interrogation doubles as a refresh of what this route advertises.
  ctx.llm.registerModelDiscovery(settingsNs, (_request, signal) => probeCatalog(signal))
}
