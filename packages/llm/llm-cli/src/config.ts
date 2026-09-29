/**
 * Plugin configuration and the one resolve step from raw config to validated
 * executable facts.
 *
 * Every field is `Volatile`, so a Models-page edit reaches the next request
 * through the loader's volatile update without restarting anything. The resolve
 * step re-judges every default and bound because programmatic construction and
 * a settings snapshot both bypass Schemastery normalization.
 *
 * @module @deepseek-ai/dsh-llm-cli/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  CLI_TRANSPORTS,
  CODEBUDDY_EFFORT_LEVELS,
  CODEBUDDY_PERMISSION_MODES,
  DEFAULT_TRANSPORT,
} from './adapter.ts'
import type {
  CliCatalogModel,
  CliConnectionOptions,
  CliTransport,
  CodeBuddyEffort,
  CodeBuddyPermissionMode,
} from './adapter.ts'

/** The default CLI executable; a bare name resolves on PATH. */
export const DEFAULT_COMMAND = 'codebuddy'

/**
 * Base arguments producing stream-json on stdout with a trailing positional
 * prompt. Partial messages are requested too: without them the CLI reports a
 * message only once it is complete, so a caller waits out the child's whole
 * agent loop — tool rounds included — before the first character arrives.
 */
export const DEFAULT_ARGS: readonly string[] = [
  '--print',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
]

/** The argument that carries the persistent session id. */
export const DEFAULT_SESSION_ID_ARG = '--session-id'

/** Permission mode that makes a delegated, non-interactive CLI run usable by default. */
export const DEFAULT_PERMISSION_MODE: CodeBuddyPermissionMode = 'bypassPermissions'

/** Default graceful-termination window for a CLI child. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Arguments that start the CLI as a long-lived ACP agent on stdio. */
export const DEFAULT_ACP_ARGS: readonly string[] = ['--acp']

/** Arguments that print the CLI's supported model ids without starting an agent session. */
export const DEFAULT_MODEL_DISCOVERY_ARGS: readonly string[] = ['--help']

/** Default ceiling for one model-discovery child. */
export const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 15_000

/**
 * Plugin config, validated by the same-named schemastery schema and doubling as
 * the `llm-cli` user-settings section shape. Every field is optional in yml: a
 * missing command falls back to `codebuddy`, and an empty section still
 * registers the route with the defaults.
 */
export interface Config {
  /** CLI executable; a bare name resolves on PATH. */
  command: Volatile<string>
  /** Arguments producing stream-json on stdout; the prompt is appended last. */
  args: Volatile<string[]>
  /** Arguments that start the CLI as a long-lived ACP agent; used by the `acp` transport. */
  acpArgs: Volatile<string[]>
  /** Arguments that print the CLI's supported model ids without starting an agent session. */
  modelDiscoveryArgs: Volatile<string[]>
  /** Hard ceiling in milliseconds for one model-discovery child. */
  modelDiscoveryTimeoutMs: Volatile<number>
  /** Advisory model ids offered beside the discovered ones. */
  models: Volatile<CliCatalogModel[]>
  /** Child working directory; when absent, a persistent session's workspace wins. */
  cwd: Volatile<string | undefined>
  /** Explicit environment entries layered over the subprocess seam's base. */
  env: Volatile<Record<string, string>>
  /** Argument carrying the persistent session id; an empty value disables CLI-side sessions. */
  sessionIdArg: Volatile<string>
  /**
   * How a call reaches the CLI: `print` starts a child per call, `acp` keeps
   * one child per route and prompts a session on it.
   */
  transport: Volatile<CliTransport>
  /** The CLI's own tool-approval policy for the delegated run. */
  permissionMode: Volatile<CodeBuddyPermissionMode>
  /**
   * Tool set the delegated run restricts itself to. An empty value disables
   * every built-in tool, which reduces the CLI to a model call; absent leaves
   * the CLI's own default set.
   */
  tools: Volatile<string | undefined>
  /**
   * Cap on the CLI's own agentic turns. Absent leaves the CLI's own default,
   * which is what lets it run a whole tool loop inside one call.
   */
  maxTurns: Volatile<number | undefined>
  /** Reasoning effort the CLI forwards to the model; absent leaves its own default. */
  effort: Volatile<CodeBuddyEffort | undefined>
  /** Grace in milliseconds for child process-tree termination. */
  disposeGraceMs: Volatile<number>
}

/**
 * Plain config accepted by the resolver: one detached value per option. Derived
 * from {@link Config} so the two cannot drift; each value is a frozen snapshot
 * of a volatile reference, read-only in practice.
 */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? Exclude<T, undefined> : never }

/**
 * Read the current value behind every reference of a parsed {@link Config}.
 * Every schema field is volatile, so each entry is a reference by construction.
 * @param config - parsed plugin config.
 * @returns one detached value per option.
 */
export function plainOptions(config: Config): Options {
  const plain: Record<string, unknown> = {}
  // Object.keys is typed through the declared Config, so a field added to the
  // interface is read here without a second list to keep in step.
  for (const key of Object.keys(config) as Array<keyof Config>) plain[key] = config[key].get()
  return plain
}

/** Advisory catalog entry as it appears in yml. */
const catalogModel: z<CliCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
})

/** Fields shared by the plugin entry config and the `llm-cli` settings section. */
export const cliConfigFields = {
  command: z.string().default(DEFAULT_COMMAND).volatile(),
  args: z.array(z.string()).default([...DEFAULT_ARGS]).volatile(),
  acpArgs: z.array(z.string()).default([...DEFAULT_ACP_ARGS]).volatile(),
  modelDiscoveryArgs: z.array(z.string()).default([...DEFAULT_MODEL_DISCOVERY_ARGS]).volatile(),
  modelDiscoveryTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS).volatile(),
  models: z.array(catalogModel).default([]).volatile(),
  cwd: z.string().volatile(),
  env: z.dict(z.string()).default({}).volatile(),
  sessionIdArg: z.string().default(DEFAULT_SESSION_ID_ARG).volatile(),
  transport: z.union(CLI_TRANSPORTS).default(DEFAULT_TRANSPORT).volatile(),
  permissionMode: z.union(CODEBUDDY_PERMISSION_MODES).default(DEFAULT_PERMISSION_MODE).volatile(),
  tools: z.string().volatile(),
  maxTurns: z.natural().min(1).volatile(),
  effort: z.union(CODEBUDDY_EFFORT_LEVELS).volatile(),
  disposeGraceMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_DISPOSE_GRACE_MS).volatile(),
}

export const Config = z.object(cliConfigFields)

/** Validated executable facts for one operation, as the adapter reads them. */
export type ResolvedCliOptions = CliConnectionOptions

/**
 * Validate a millisecond bound that must be a positive finite number inside the
 * timer ceiling, which is what both the spawn grace and the discovery deadline
 * are handed to.
 * @param value - the resolved bound.
 * @param field - option name used in the diagnostic.
 * @returns the same value once it is accepted.
 */
function timerBound(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-cli: ${field} must be a positive finite number no greater than ${String(MAX_TIMER_DELAY_MS)}`)
  }
  return value
}

/** Reject a blank argument list entry, which would silently shift the prompt. */
function assertNoBlankArg(args: readonly string[], field: string): void {
  if (args.some(arg => arg.length === 0)) throw new Error(`llm-cli: ${field} must not contain an empty argument`)
}

/** Validate and detach the advisory model catalog. */
function resolveModels(models: readonly CliCatalogModel[] | undefined): CliCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? []).map((model) => {
    if (model.id.length === 0) throw new Error('llm-cli: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-cli: catalog model "${model.id}" has an empty name`)
    }
    if (seen.has(model.id)) throw new Error(`llm-cli: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return model.name === undefined ? { id: model.id } : { id: model.id, name: model.name }
  })
}

/**
 * Merge what the CLI last advertised with the ids the deployment declared. The
 * advertised order leads — it is the CLI's own listing, which is what a picker
 * should show — and a declared entry keeps its own content there, so a curated
 * label is not replaced by the bare id. Declared ids the CLI did not report
 * follow, so an advisory id stays selectable.
 * @param configured - catalog entries the deployment declared.
 * @param discovered - entries the last probe of the CLI reported.
 * @returns one entry per id, advertised order first.
 */
export function mergeCatalog(
  configured: readonly CliCatalogModel[],
  discovered: readonly CliCatalogModel[],
): CliCatalogModel[] {
  const declared = new Map(configured.map(model => [model.id, model]))
  const seen = new Set<string>()
  const merged: CliCatalogModel[] = []
  for (const model of [...discovered, ...configured]) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    merged.push(declared.get(model.id) ?? model)
  }
  return merged
}

/**
 * The one explicit resolve step from raw config to validated executable facts.
 * @param config - raw plugin config or a resolved settings snapshot.
 * @param defaultCwd - fallback working directory for the CLI child.
 * @returns validated executable facts for the adapter.
 */
export function resolveAdapterOptions(config: Options, defaultCwd: string): ResolvedCliOptions {
  const command = config.command ?? DEFAULT_COMMAND
  if (command.trim().length === 0) throw new Error('llm-cli: command must be non-empty')
  const args = config.args ?? DEFAULT_ARGS
  assertNoBlankArg(args, 'args')
  const transport = config.transport ?? DEFAULT_TRANSPORT
  if (!CLI_TRANSPORTS.includes(transport)) {
    throw new Error(`llm-cli: unsupported transport "${transport}"`)
  }
  const permissionMode = config.permissionMode ?? DEFAULT_PERMISSION_MODE
  if (!CODEBUDDY_PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`llm-cli: unsupported permissionMode "${permissionMode}"`)
  }
  const disposeGraceMs = timerBound(config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS, 'disposeGraceMs')
  const acpArgs = config.acpArgs ?? DEFAULT_ACP_ARGS
  assertNoBlankArg(acpArgs, 'acpArgs')
  const discoveryArgs = config.modelDiscoveryArgs ?? DEFAULT_MODEL_DISCOVERY_ARGS
  assertNoBlankArg(discoveryArgs, 'modelDiscoveryArgs')
  const discoveryTimeoutMs = timerBound(
    config.modelDiscoveryTimeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
    'modelDiscoveryTimeoutMs',
  )
  // An empty sessionIdArg is the documented way to ask for stateless runs.
  const sessionIdArg = config.sessionIdArg ?? DEFAULT_SESSION_ID_ARG
  const maxTurns = config.maxTurns
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
    throw new Error('llm-cli: maxTurns must be a positive whole number')
  }
  const effort = config.effort
  if (effort !== undefined && !CODEBUDDY_EFFORT_LEVELS.includes(effort)) {
    throw new Error(`llm-cli: unsupported effort "${effort}"`)
  }
  return {
    argv: [command, ...args],
    cwd: config.cwd ?? defaultCwd,
    useSessionCwd: config.cwd === undefined,
    env: { ...(config.env ?? {}) },
    ...sessionIdArg.length === 0 ? {} : { sessionIdArg },
    transport,
    permissionMode,
    // An empty tools value is a choice — every built-in tool off — so only an
    // absent one leaves the flag out and the CLI's own set in place.
    ...config.tools === undefined ? {} : { tools: config.tools },
    ...maxTurns === undefined ? {} : { maxTurns },
    ...effort === undefined ? {} : { effort },
    disposeGraceMs,
    acpArgv: [command, ...acpArgs],
    discoveryArgv: [command, ...discoveryArgs],
    discoveryTimeoutMs,
    models: resolveModels(config.models),
  }
}
