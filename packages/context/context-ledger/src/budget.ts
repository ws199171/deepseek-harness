/**
 * Budget profiles for the ledger's always-on injection.
 *
 * Project-scope knowledge is injected into every session of a project, so its
 * size is a standing tax. A profile is a named bundle of ceilings that a
 * deployment selects instead of tuning each number, and {@link resolveBudget} is
 * the explicit step that turns that request into the values actually enforced.
 *
 * **Units are bytes, not tokens.** A token-denominated ceiling would need a
 * tokenizer this plugin does not have; reporting a byte count as a token count
 * would overstate what is known. Byte ceilings are exact, and `ledger_status`
 * reports the session's real token usage separately, labelled as session-wide
 * rather than as the ledger's own share.
 *
 * @module dsh-context-ledger/budget
 */

/** Every ceiling a profile or an override may set. */
export type BudgetCeilingKey =
  | 'maxIdentityBytes'
  | 'maxIndexEntries'
  | 'maxIndexBytes'
  | 'maxIndexEntryBytes'
  | 'maxEntryBytes'
  | 'maxSearchResults'
  | 'maxExcerptChars'
  | 'maxArchiveRows'
  | 'maxArchivedPaths'
  | 'maxBriefBytes'
  | 'maxConventionFileBytes'
  | 'maxConventionSessionBytes'

/** The ceilings themselves, all of them present. */
export type BudgetCeilings = Readonly<Record<BudgetCeilingKey, number>>

/** A ceiling profile name — one rung of the adaptive ladder. */
export type BudgetRungName = 'frugal' | 'balanced' | 'full'

/** Every selectable profile name, including the adaptive mode. */
export type BudgetProfileName = BudgetRungName | 'adaptive'

/** Ceilings plus the profile they came from. */
export interface BudgetSpec extends BudgetCeilings {
  /** The ceiling profile the values came from. */
  readonly profile: string
}

/**
 * The ceiling profiles, narrowest first. These are the rungs an adaptive
 * deployment chooses between.
 *
 * `full` raises every ceiling but keeps them: an always-on injection with no
 * bound is the failure these ceilings exist to prevent, so a deployment that
 * wants one states it through an override, where it is visible in review.
 */
export const BUDGET_PROFILES: Readonly<Record<BudgetRungName, BudgetCeilings>> = Object.freeze({
  frugal: Object.freeze({
    maxIdentityBytes: 512,
    maxIndexEntries: 4,
    maxIndexBytes: 512,
    maxIndexEntryBytes: 96,
    maxEntryBytes: 4096,
    maxSearchResults: 5,
    maxExcerptChars: 120,
    maxArchiveRows: 3,
    maxArchivedPaths: 10,
    maxBriefBytes: 2048,
    maxConventionFileBytes: 4096,
    maxConventionSessionBytes: 8192,
  }),
  balanced: Object.freeze({
    maxIdentityBytes: 2048,
    maxIndexEntries: 16,
    maxIndexBytes: 2048,
    maxIndexEntryBytes: 160,
    maxEntryBytes: 16384,
    maxSearchResults: 10,
    maxExcerptChars: 240,
    maxArchiveRows: 10,
    maxArchivedPaths: 20,
    maxBriefBytes: 4096,
    maxConventionFileBytes: 16384,
    maxConventionSessionBytes: 32768,
  }),
  full: Object.freeze({
    maxIdentityBytes: 8192,
    maxIndexEntries: 48,
    maxIndexBytes: 8192,
    maxIndexEntryBytes: 320,
    maxEntryBytes: 65536,
    maxSearchResults: 25,
    maxExcerptChars: 480,
    maxArchiveRows: 25,
    maxArchivedPaths: 40,
    maxBriefBytes: 8192,
    maxConventionFileBytes: 65536,
    maxConventionSessionBytes: 131072,
  }),
})

/** The default ceiling profile. */
export const DEFAULT_BUDGET_PROFILE: BudgetRungName = 'balanced'

/**
 * The rung below {@link BUDGET_PROFILES.frugal}: no memory headlines at all.
 *
 * Adaptive selection needs a floor for a window too full to carry even the
 * narrowest profile. It is not a profile of its own because it is not something
 * a deployment should select directly — it means "the window is nearly gone, so
 * stop adding".
 */
export const IDENTITY_ONLY_RUNG = 'identity-only'

/** Every rung name, and the ladder adaptive selection walks, narrowest first. */
export const BUDGET_RUNG_NAMES: readonly BudgetRungName[] = Object.freeze(['frugal', 'balanced', 'full'])

/** Every selectable profile name, including the adaptive mode. */
export const BUDGET_PROFILE_NAMES: readonly BudgetProfileName[] = Object.freeze([
  ...BUDGET_RUNG_NAMES,
  'adaptive',
])

/** Every ceiling key a profile or override may set. */
export const BUDGET_CEILING_KEYS: readonly BudgetCeilingKey[] = Object.freeze(
  Object.keys(BUDGET_PROFILES.balanced) as BudgetCeilingKey[],
)

/** The default free-window fraction available to the adaptive mode. */
export const DEFAULT_ADAPTIVE_RATIO = 0.05

const CEILING_KEY_SET: ReadonlySet<string> = new Set<string>(BUDGET_CEILING_KEYS)
const RUNG_NAME_SET: ReadonlySet<string> = new Set<string>(BUDGET_RUNG_NAMES)

/**
 * Validate a set of overrides and fold them over a base.
 *
 * @param base - The base ceilings.
 * @param overrides - Caller overrides, keyed by ceiling name.
 * @returns The merged ceilings.
 * @throws TypeError When an override key is not a ceiling.
 * @throws RangeError When an override is not a non-negative integer.
 */
function applyOverrides(
  base: BudgetCeilings,
  overrides: Readonly<Record<string, number>> | undefined,
): BudgetCeilings {
  const supplied = overrides ?? {}
  for (const key of Object.keys(supplied)) {
    if (!CEILING_KEY_SET.has(key)) {
      throw new TypeError(
        `dsh-context-ledger: unknown budget ceiling ${JSON.stringify(key)}; expected one of ${BUDGET_CEILING_KEYS.join(', ')}`,
      )
    }
  }
  const merged: Record<BudgetCeilingKey, number> = { ...base }
  for (const [key, value] of Object.entries(supplied)) {
    // Zero is a usable ceiling meaning "none": it is how the identity-only floor
    // expresses "no headlines", and how a deployment turns one path off without
    // changing profiles.
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(
        `dsh-context-ledger: budget ceiling ${JSON.stringify(key)} must be a non-negative integer, received ${String(value)}`,
      )
    }
    merged[key as BudgetCeilingKey] = value
  }
  return Object.freeze(merged)
}

/**
 * Build the ceilings for one rung.
 *
 * @param request - The rung request.
 * @param request.rung - A rung name, or the identity-only floor.
 * @param request.overrides - Per-ceiling overrides.
 * @returns The frozen ceilings.
 * @throws TypeError When the rung is unknown or an override key is not a ceiling.
 * @throws RangeError When an override is not a non-negative integer.
 */
export function budgetForRung(request: {
  rung: string
  overrides?: Readonly<Record<string, number>> | undefined
}): BudgetSpec {
  const { rung, overrides } = request
  if (rung === IDENTITY_ONLY_RUNG) {
    const floor = applyOverrides({ ...BUDGET_PROFILES.frugal, maxIndexEntries: 0, maxIndexBytes: 0 }, overrides)
    return Object.freeze({ profile: IDENTITY_ONLY_RUNG, ...floor })
  }
  if (!RUNG_NAME_SET.has(rung)) {
    throw new TypeError(
      `dsh-context-ledger: unknown budget profile ${JSON.stringify(rung)}; expected one of ${BUDGET_RUNG_NAMES.join(', ')}`,
    )
  }
  const profile = BUDGET_PROFILES[rung as BudgetRungName]
  return Object.freeze({ profile: rung, ...applyOverrides(profile, overrides) })
}

/**
 * Turn a profile request into the ceilings the plugin enforces.
 *
 * `adaptive` is not a set of ceilings, so it cannot be resolved here: a
 * deployment that selects it resolves a rung per session through
 * {@link resolveAdaptiveRung} and {@link budgetForRung}.
 *
 * @param request - The configured budget block.
 * @returns The frozen ceilings actually in force.
 * @throws TypeError When the profile name is unknown or is the adaptive mode.
 * @throws RangeError When a ceiling is not a non-negative integer.
 */
export function resolveBudget(
  request: { profile?: string | undefined; overrides?: Readonly<Record<string, number>> | undefined } | undefined,
): BudgetSpec {
  const profileName = request?.profile ?? DEFAULT_BUDGET_PROFILE
  if (profileName === 'adaptive') {
    throw new TypeError(
      'dsh-context-ledger: the adaptive profile is resolved per session, not to a fixed set of ceilings',
    )
  }
  return budgetForRung({ rung: profileName, overrides: request?.overrides })
}

/**
 * Choose the rung a session can afford from its remaining window.
 *
 * The rung is the widest one whose whole-block ceiling fits inside the fraction
 * of the free window the deployment is willing to spend. When the window is
 * unmeasurable — no token meter, no routed model — this reports the default
 * profile rather than guessing, because a wrong guess is either a silently empty
 * ledger or a silently oversized one.
 *
 * @param request - The measurement.
 * @param request.usedTokens - Tokens the session's log currently occupies.
 * @param request.contextWindow - The routed model's window.
 * @param request.ratio - Fraction of the free window the ledger may spend.
 * @returns A rung name, or the identity-only floor.
 */
export function resolveAdaptiveRung(request: {
  usedTokens: number | undefined
  contextWindow: number | undefined
  ratio: number
}): string {
  const { usedTokens, contextWindow, ratio } = request
  if (usedTokens === undefined || contextWindow === undefined) return DEFAULT_BUDGET_PROFILE
  if (!Number.isFinite(usedTokens) || !Number.isFinite(contextWindow)) return DEFAULT_BUDGET_PROFILE
  if (!Number.isFinite(ratio) || ratio <= 0) return DEFAULT_BUDGET_PROFILE
  const available = Math.max(0, contextWindow - usedTokens) * ratio
  for (const rung of [...BUDGET_RUNG_NAMES].reverse()) {
    if (BUDGET_PROFILES[rung].maxIdentityBytes <= available) return rung
  }
  return IDENTITY_ONLY_RUNG
}

/**
 * Resolve the ceilings in force for one session.
 *
 * This is the single composition point for a configured profile and a measured
 * window, so a deployment's static choice and its adaptive choice cannot diverge
 * in how they build a spec. Callers pass `undefined` measurements to get the
 * budget a session has before its first checkpoint.
 *
 * @param request - The resolution request.
 * @param request.profile - A profile name.
 * @param request.overrides - Per-ceiling overrides.
 * @param request.ratio - Free-window fraction, for the adaptive mode.
 * @param request.usedTokens - Tokens the session's log occupies.
 * @param request.contextWindow - The routed model's window.
 * @returns The chosen rung and its ceilings.
 * @throws TypeError When the profile or an override key is unknown.
 * @throws RangeError When a ceiling is not a non-negative integer.
 */
export function resolveSessionBudget(request: {
  profile: string
  overrides?: Readonly<Record<string, number>> | undefined
  ratio?: number | undefined
  usedTokens?: number | undefined
  contextWindow?: number | undefined
}): { rung: string; budget: BudgetSpec } {
  const { profile, overrides, ratio, usedTokens, contextWindow } = request
  if (profile !== 'adaptive') return { rung: profile, budget: budgetForRung({ rung: profile, overrides }) }
  const rung = resolveAdaptiveRung({
    usedTokens,
    contextWindow,
    ratio: ratio ?? DEFAULT_ADAPTIVE_RATIO,
  })
  return { rung, budget: budgetForRung({ rung, overrides }) }
}
