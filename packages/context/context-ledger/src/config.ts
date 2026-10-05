/**
 * Configuration for `dsh-context-ledger`.
 *
 * Every deployment-varying choice is a validated field here rather than a
 * constant, so a profile's `cordis.patch.yml` can change behavior without a code
 * edit. {@link DEFAULTS} is the single source of truth: the schemastery schema and
 * {@link resolveConfig} both read it, so a default never has two owners.
 *
 * The injection ceilings are deliberately not listed here. They come from a
 * budget profile, so `maxIdentityBytes` and its siblings have exactly one owner
 * in `budget.ts` and change through `budgetOverrides`.
 *
 * @module @deepseek-ai/dsh-context-ledger/config
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import {
  BUDGET_PROFILE_NAMES,
  DEFAULT_ADAPTIVE_RATIO,
  DEFAULT_BUDGET_PROFILE,
  resolveSessionBudget,
  type BudgetProfileName,
  type BudgetSpec,
} from './budget.ts'

/**
 * The deployment defaults, used by both the schema and the resolver.
 *
 * `contextOrder` is a bare number rather than a name from the Harness's
 * `CONTEXT_ORDERS` map: that map is a closed union a third-party plugin cannot
 * extend, while `SystemPrompt.context()` accepts any finite order. 100 places the
 * block ahead of `SANDBOX_POLICY` (110). Equal orders fall back to name order, so
 * a collision degrades ordering rather than failing.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  archiveEnabled: true,
  contextOrder: 100,
  projectRootMarkers: Object.freeze(['.git']),
  stackManifestNames: Object.freeze(['package.json']),
  conventionFileNames: Object.freeze(['CONTEXT.md']),
  includeProjectName: true,
  budgetProfile: DEFAULT_BUDGET_PROFILE,
  adaptiveUtilizationRatio: DEFAULT_ADAPTIVE_RATIO,
})

/** User-facing configuration for the project context ledger. */
export interface Config {
  /** Whether the plugin contributes anything at all; `false` disables every layer. */
  enabled?: boolean
  /** Whether a session is archived to this project's ledger when it ends. */
  archiveEnabled?: boolean
  /** Ascending placement among runtime contexts; 100 sits ahead of `SANDBOX_POLICY`. */
  contextOrder?: number
  /** Directory entries that identify a project root while walking upward from the session cwd. */
  projectRootMarkers?: string[]
  /** Manifest names probed at the project root and reported on the `Stack` line. */
  stackManifestNames?: string[]
  /** File names read as directory-scoped conventions when their directory is touched. */
  conventionFileNames?: string[]
  /** Whether the project directory name is rendered as the `Project` line. */
  includeProjectName?: boolean
  /** The ceiling profile to enforce, or the adaptive mode that picks a rung per session. */
  budgetProfile?: BudgetProfileName | null
  /** Per-ceiling overrides applied over whichever profile is in force. */
  budgetOverrides?: Record<string, number>
  /** Fraction of the free window the adaptive mode may spend on the injected block. */
  adaptiveUtilizationRatio?: number
  /** Harness home holding the ledger; defaults to `$DSH_HOME`. */
  ledgerHome?: string
}

/**
 * Plugin configuration schema, validated by the Cordis loader at activation.
 *
 * The loader reads this from the plugin's `Config` export and validates each row's
 * `config` before `apply` runs, so a malformed profile patch fails at load rather
 * than at first assembly.
 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  archiveEnabled: z.boolean().default(DEFAULTS.archiveEnabled),
  contextOrder: z.number().default(DEFAULTS.contextOrder),
  projectRootMarkers: z.array(z.string()).default([...DEFAULTS.projectRootMarkers]),
  stackManifestNames: z.array(z.string()).default([...DEFAULTS.stackManifestNames]),
  conventionFileNames: z.array(z.string()).default([...DEFAULTS.conventionFileNames]),
  includeProjectName: z.boolean().default(DEFAULTS.includeProjectName),
  budgetProfile: z.union([...BUDGET_PROFILE_NAMES]).default(DEFAULTS.budgetProfile),
  budgetOverrides: z.dict(z.number()).default({}),
  adaptiveUtilizationRatio: z.number().default(DEFAULTS.adaptiveUtilizationRatio),
  ledgerHome: z.string(),
})

/** The values the plugin actually enforces, with every default applied. */
export interface ResolvedConfig {
  /** Whether the plugin contributes anything at all. */
  enabled: boolean
  /** Whether an ended session is archived. */
  archiveEnabled: boolean
  /** Ascending placement among runtime contexts. */
  contextOrder: number
  /** Child names identifying a project root. */
  projectRootMarkers: readonly string[]
  /** Manifests feeding the stack line. */
  stackManifestNames: readonly string[]
  /** Directory-scoped convention file names. */
  conventionFileNames: readonly string[]
  /** Whether the project directory name is rendered. */
  includeProjectName: boolean
  /** Absolute root of the ledger's storage. */
  ledgerHome: string
  /** The configured profile name, adaptive mode included. */
  budgetProfile: string
  /** Per-ceiling overrides. */
  budgetOverrides: Readonly<Record<string, number>>
  /** Free-window fraction for the adaptive mode. */
  adaptiveUtilizationRatio: number
  /**
   * The ceilings in force before a session's first adaptive checkpoint, and the
   * only ceilings a static deployment ever uses.
   */
  budget: BudgetSpec
}

/**
 * Turn a raw plugin config into the values the plugin actually enforces.
 *
 * This is an explicit resolve step rather than a hidden default inside the
 * assembly path, so the enforced values are inspectable through `ledger_status`
 * and reproducible on replay. Each field falls back to {@link DEFAULTS} when the
 * loader supplied no value, which keeps the plugin usable when it is applied
 * without a `config` row.
 *
 * The budget is resolved once here even under the adaptive mode, so an unknown
 * override key or an unusable ratio fails activation rather than the first
 * assembly.
 *
 * @param request - Raw config from the profile patch.
 * @returns The validated, frozen configuration.
 * @throws TypeError When the budget profile, an override key, or the ratio is unusable.
 * @throws RangeError When a marker list or a ceiling is unusable.
 */
export function resolveConfig(request: Config | undefined): ResolvedConfig {
  const source = request ?? {}
  const budgetProfile = source.budgetProfile ?? DEFAULTS.budgetProfile
  const budgetOverrides: Readonly<Record<string, number>> = Object.freeze({ ...(source.budgetOverrides ?? {}) })
  const adaptiveUtilizationRatio = source.adaptiveUtilizationRatio ?? DEFAULTS.adaptiveUtilizationRatio
  if (!Number.isFinite(adaptiveUtilizationRatio) || adaptiveUtilizationRatio <= 0) {
    throw new RangeError(
      `dsh-context-ledger: adaptiveUtilizationRatio must be a positive number, received ${String(adaptiveUtilizationRatio)}`,
    )
  }
  const { budget } = resolveSessionBudget({
    profile: budgetProfile,
    overrides: budgetOverrides,
    ratio: adaptiveUtilizationRatio,
  })
  const resolved: ResolvedConfig = {
    enabled: source.enabled ?? DEFAULTS.enabled,
    archiveEnabled: source.archiveEnabled ?? DEFAULTS.archiveEnabled,
    contextOrder: source.contextOrder ?? DEFAULTS.contextOrder,
    projectRootMarkers: Object.freeze([...(source.projectRootMarkers ?? DEFAULTS.projectRootMarkers)]),
    stackManifestNames: Object.freeze([...(source.stackManifestNames ?? DEFAULTS.stackManifestNames)]),
    conventionFileNames: Object.freeze([...(source.conventionFileNames ?? DEFAULTS.conventionFileNames)]),
    includeProjectName: source.includeProjectName ?? DEFAULTS.includeProjectName,
    ledgerHome: source.ledgerHome ?? resolveDshHome(),
    budgetProfile,
    budgetOverrides,
    adaptiveUtilizationRatio,
    budget,
  }

  if (!Number.isFinite(resolved.contextOrder)) {
    throw new TypeError(
      `dsh-context-ledger: contextOrder must be a finite number, received ${String(resolved.contextOrder)}`,
    )
  }
  if (resolved.projectRootMarkers.length === 0) {
    throw new RangeError(
      'dsh-context-ledger: projectRootMarkers must name at least one marker, otherwise no directory is ever a project root',
    )
  }
  if (resolved.stackManifestNames.length === 0) {
    throw new RangeError(
      'dsh-context-ledger: stackManifestNames must name at least one manifest, otherwise the stack line is always empty',
    )
  }
  return Object.freeze(resolved)
}
