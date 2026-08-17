/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-llm-cli`.
 * @module @deepseek-ai/dsh-llm-cli/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { CLI_CANDIDATES, discoverAll } from './discovery.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-cli'

/** Cordis companion plugin name. */
export const name = 'llm-cli-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * The package owns one runtime invariant: a discovery round must enumerate
 * the same id set the package actually advertises, so a stale registry cannot
 * silently hide a CLI the UI promised.
 */
const install: InvariantInstaller = async (ctx) => {
  const recordedIds = new Set(CLI_CANDIDATES.map(candidate => candidate.id))
  const discovered = await discoverAll()
  for (const entry of discovered) {
    if (!recordedIds.has(entry.id)) {
      ctx.logger.error(`llm-cli invariant: discovery surfaced unknown id "${entry.id}"`)
    }
  }
  if (discovered.length !== recordedIds.size) {
    const missing = [...recordedIds].filter(id => !discovered.some(entry => entry.id === id))
    ctx.logger.error(`llm-cli invariant: discovery missed ids ${missing.join(', ')}`)
  }
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
