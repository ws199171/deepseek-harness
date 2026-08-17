/**
 * Register a {@link CliAdapter} for one CLI-backed provider route on
 * `ctx.llm`. The plugin layers its `cordis.yml` entry config under the
 * optional `llm-cli` user-settings section (`ctx.settings`), so a changed
 * command, argument list, or model catalog reaches the very next request
 * without restarting anything (the provider route id itself is a
 * registration-time fact — changing it takes a restart, like every adapter
 * route). Executable facts resolve per request instead of freezing at load;
 * the CLI child runs through the shared subprocess seam (`ctx.subprocess`),
 * inheriting its process-tree termination and environment-scrubbing
 * guarantees.
 *
 * The route exists so a deployment can answer model requests without any API
 * key: the configured CLI (for example CodeBuddy) carries its own
 * authentication and runs its own agentic loop with its own tools. The
 * harness forwards conversation text and receives the final answer.
 *
 * @module @deepseek-ai/dsh-llm-cli
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  CliAdapter,
  CODEBUDDY_PERMISSION_MODES,
  DEFAULT_CODEBUDDY_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
} from './adapter.ts'
import type { CliCatalogModel, CliConnectionOptions, CodeBuddyPermissionMode } from './adapter.ts'
import { CliDiscoveryService } from './service.ts'

export {
  CliAdapter,
  CODEBUDDY_PERMISSION_MODES,
  DEFAULT_CODEBUDDY_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
} from './adapter.ts'
export type {
  CliAdapterOptions,
  CliCatalogModel,
  CliConnectionOptions,
  CodeBuddyPermissionMode,
} from './adapter.ts'
export * from './translate.ts'
export * from './wire.ts'
export * from './discovery.ts'
export * from './service.ts'
export type {
  CliCandidate, CliDiscovered, CliDiscoverResultView, CliModel, CliPresence, CliHealth,
  CliTestRequest, CliTestResult,
} from './spec.ts'

export const name = 'llm-cli'
export const inject = ['llm', 'subprocess', 'sessions']

const NS = settingsNamespace('llm-cli')
/** The single provider route this plugin owns. */
const DEFAULT_PROVIDER = 'codebuddy-cli'
/** The default CLI executable name. */
const DEFAULT_COMMAND = 'codebuddy'
/** Base arguments producing stream-json on stdout with a positional prompt. */
const DEFAULT_ARGS = ['--print', '--output-format', 'stream-json']
/** The argument that carries the persistent session id (undefined disables persistence). */
const DEFAULT_SESSION_ID_ARG = '--session-id'

const DEFAULT_MODELS: CliCatalogModel[] = []

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-cli` settings-section shape. Every field is optional in yml:
 * a missing command falls back to `codebuddy`, and an empty settings section
 * still registers the route with the defaults.
 */
export interface Config {
  /** CLI executable name (default `codebuddy`); a bare name resolves on PATH. */
  command?: string
  /** Arguments appended before any per-request session arguments. */
  args?: string[]
  /** Provider route id this plugin registers (default `codebuddy-cli`). A registration-time fact. */
  provider?: string
  /** Human-readable provider name for selectors (default `CodeBuddy CLI`). */
  displayName?: string
  /** Model ids discovered from CodeBuddy or entered by the deployment. */
  models?: CliCatalogModel[]
  /** Child working directory; when absent, persistent sessions use their selected workspace. */
  cwd?: string
  /** Explicit environment entries layered over the subprocess seam's base. */
  env?: Record<string, string>
  /** Argument carrying the persistent session id (default `--session-id`). */
  sessionIdArg?: string
  /** CodeBuddy tool-approval policy (default `bypassPermissions` for non-interactive runs). */
  permissionMode?: CodeBuddyPermissionMode
  /** Grace in milliseconds for child process-tree termination. */
  disposeGraceMs?: number
}

const catalogModel: z<CliCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
})

export const Config: z<Config> = z.object({
  command: z.string().default(DEFAULT_COMMAND),
  args: z.array(z.string()).default(DEFAULT_ARGS),
  provider: z.string().default(DEFAULT_PROVIDER),
  displayName: z.string(),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  cwd: z.string(),
  env: z.dict(z.string()).default({}),
  sessionIdArg: z.string().default(DEFAULT_SESSION_ID_ARG),
  permissionMode: z.union([...CODEBUDDY_PERMISSION_MODES]).default(DEFAULT_CODEBUDDY_PERMISSION_MODE),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

/** A resolved provider/model route on the CLI adapter, validated once per use. */
export type ResolvedCliOptions = CliConnectionOptions

/** Minimal dynamic session-store view used without creating an llm -> session project cycle. */
interface SessionCwdSource {
  get(sessionId: NonNullable<import('@deepseek-ai/dsh-llm').GenerateOptions['sessionId']>): {
    readonly header: { readonly cwd?: string }
  } | undefined
}

/** Validate and detach the advisory model catalog. */
function resolveModels(models: readonly CliCatalogModel[] | undefined): CliCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-cli: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-cli: catalog model "${model.id}" has an empty name`)
    }
    if (seen.has(model.id)) throw new Error(`llm-cli: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return { id: model.id, ...(model.name === undefined ? {} : { name: model.name }) }
  })
}

/**
 * The one explicit resolve step from raw config to validated executable
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — at load (fail loud) and for
 * each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param defaultCwd - fallback working directory for the CLI child.
 * @returns validated executable facts for the adapter.
 */
export function resolveAdapterOptions(config: Config, defaultCwd: string): ResolvedCliOptions {
  const command = config.command ?? DEFAULT_COMMAND
  if (command.trim().length === 0) throw new Error('llm-cli: command must be non-empty')
  const args = config.args ?? DEFAULT_ARGS
  const permissionMode = config.permissionMode ?? DEFAULT_CODEBUDDY_PERMISSION_MODE
  if (!CODEBUDDY_PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`llm-cli: unsupported CodeBuddy permissionMode "${permissionMode}"`)
  }
  const disposeGraceMs = config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
  if (!Number.isFinite(disposeGraceMs) || disposeGraceMs <= 0 || disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-cli: disposeGraceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  // Windows npm/pnpm installs expose the CLI as a .cmd shim, which requires
  // cmd.exe; the argv is constant per resolution so no task text enters the
  // shell boundary (the shared subprocess seam never shell-interprets argv
  // on POSIX, matching the Codex provider's platform boundary).
  const argv = process.platform === 'win32' && !/\.(exe|cmd)$/i.test(command)
    ? ['cmd.exe', '/d', '/s', '/c', command, ...args]
    : [command, ...args]
  return {
    argv,
    cwd: config.cwd ?? defaultCwd,
    useSessionCwd: config.cwd === undefined,
    env: { ...(config.env ?? {}) },
    ...(config.sessionIdArg === undefined ? {} : { sessionIdArg: config.sessionIdArg }),
    permissionMode,
    disposeGraceMs,
    models: resolveModels(config.models),
  }
}

export function apply(ctx: Context, config: Config): void {
  const sessions = ctx.get('sessions') as SessionCwdSource | undefined
  if (sessions === undefined) throw new Error('llm-cli: the session store is required')
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedCliOptions | undefined
  const options = (): ResolvedCliOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw, process.cwd())
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-cli: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  // Fail loud at load for a broken composition entry.
  const initial = resolveAdapterOptions(config, process.cwd())
  lastRaw = config
  lastGood = initial

  // The provider route and display name are registration-time facts resolved
  // from the composition entry; a settings section can refresh command/args/
  // models per request but not rename the route.
  const provider = config.provider ?? DEFAULT_PROVIDER
  if (provider.length === 0) throw new Error('llm-cli: provider must be non-empty')
  const displayName = config.displayName ?? 'CodeBuddy CLI'
  if (displayName.length === 0) throw new Error('llm-cli: displayName must be non-empty')

  const adapter = new CliAdapter({
    options,
    spawn: spec => ctx.subprocess.spawn(spec),
    resolveSessionCwd: sessionId => sessions.get(sessionId)?.header.cwd,
  })
  ctx.llm.registerConfigurableProviders([
    { provider, displayName, settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([provider], adapter)

  // The CLI discovery Remote: `api.llm.cliDiscover` and `api.llm.cliTest` on
  // the renderer side, so the Models page can enumerate installed CLIs and
  // probe their stream-json protocol before the user commits to one.
  ctx.plugin(CliDiscoveryService)

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      // Re-judge the settings snapshot now so an invalid section is reported
      // at write time, not at the next request.
      options()
    },
  })
}
