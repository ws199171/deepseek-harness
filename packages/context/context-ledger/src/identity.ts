/**
 * Pure rendering for the project context block.
 *
 * Everything here is a deterministic function of its arguments: fixed field
 * order, LF line endings, no timestamps, no locale formatting, no ids in the
 * injected headlines. That is the whole point — the Harness materializes a
 * runtime-context snapshot only when its text differs from the retained one, so
 * byte-stable output means an unchanged project logs nothing and never churns the
 * request prefix.
 *
 * The block is one contribution rather than several: a single text means one
 * comparison decides whether anything changed, and one ceiling bounds the whole
 * injected payload.
 *
 * @module dsh-context-ledger/identity
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { BudgetSpec } from './budget.ts'
import { ENTRY_KINDS, censusOf, rankForIndex, type Entry } from './entry.ts'
import type { ManifestProbe } from './root.ts'

/** Name of the runtime-context contribution. */
export const CONTEXT_NAME = 'context-ledger:identity'

/** Everything the block is rendered from. */
export interface IdentityInput {
  /** Absolute project root. */
  readonly projectRoot: string
  /** Whether to render the project directory name. */
  readonly includeProjectName: boolean
  /** Present manifest names, from {@link presentManifests}. */
  readonly presentManifests: readonly string[]
  /** Every stored entry for this project. */
  readonly entries: readonly Entry[]
  /** The resolved ceilings. */
  readonly budget: BudgetSpec
}

const OPEN_TAG = '<project_context>'
const CLOSE_TAG = '</project_context>'

/**
 * Byte length of a string as UTF-8, which is what the ceilings are expressed in.
 *
 * @param text - The text to measure.
 * @returns Its UTF-8 byte length.
 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The stack fingerprint: the names of the configured manifests that exist.
 *
 * Presence is the whole signal. A manifest's size or change token is available
 * from the probe but is deliberately excluded — the block names the manifests it
 * finds, so an edit that does not add or remove one renders identical bytes.
 *
 * @param manifests - Probes from {@link probeManifests}.
 * @returns Present manifest names, in the configured order.
 */
export function presentManifests(manifests: readonly ManifestProbe[]): string[] {
  return manifests.filter(manifest => manifest.present).map(manifest => manifest.name)
}

/**
 * One injected headline per entry that earned a slot.
 *
 * Only the title is injected, never the body: the body is what `ledger_read` is
 * for, and keeping it out is what makes the index size independent of how verbose
 * the recorded facts are.
 *
 * @param entries - Ranked, eligible entries.
 * @returns One line per entry.
 */
export function memoryIndexLines(entries: readonly Entry[]): string[] {
  return entries.map(entry => `- [${entry.kind}] ${entry.title}`)
}

/**
 * The line that tells the model what exists beyond the injected slots.
 *
 * Without it an entry that lost its slot is indistinguishable from an entry that
 * does not exist, and the model never asks for it. It is omitted only when nothing
 * is recorded, so a project whose facts are all unconfirmed still advertises that
 * they exist.
 *
 * @param entries - Every stored entry.
 * @param injectedCount - How many entries received a slot.
 * @returns The catalog line, or `undefined` when nothing is recorded.
 */
export function catalogLine(entries: readonly Entry[], injectedCount: number): string | undefined {
  const census = censusOf(entries)
  if (census.total === 0) return undefined
  // `censusOf` increments a kind the first time it sees one, so `byKind` holds
  // only counted kinds; presence is the whole test.
  const kinds: string[] = []
  for (const kind of ENTRY_KINDS) {
    const count = census.byKind[kind]
    if (count !== undefined) kinds.push(`${kind} ${count}`)
  }
  // Unreachable guard: a non-zero total above means at least one kind counted.
  /* v8 ignore next -- a recorded entry always contributes one kind */
  const suffix = kinds.length > 0 ? ` (${kinds.join(', ')})` : ''
  return `Memory: ${census.total} recorded, ${injectedCount} shown${suffix}`
}

/**
 * Render the block, shedding optional content before failing a ceiling.
 *
 * Content is dropped whole and in a fixed order — index headlines from the least
 * important end, then the catalog line, then the stack line, then the project
 * name — because a truncated path or headline asserts something false while a
 * missing optional line does not. When even the root line cannot fit, nothing is
 * contributed.
 *
 * @param input - The values to render.
 * @returns The rendered block, or `''` when it cannot fit the ceilings.
 */
export function renderIdentity(input: IdentityInput): string {
  const { projectRoot, includeProjectName, presentManifests: present, entries, budget } = input
  const rootField: readonly [string, string] = ['Root', projectRoot]
  const named: ReadonlyArray<readonly [string, string]> = includeProjectName
    ? [['Project', basename(projectRoot)]]
    : []
  const stack: ReadonlyArray<readonly [string, string]> = present.length > 0
    ? [['Stack', present.join(', ')]]
    : []

  const ranked = rankForIndex(entries, budget)
  const headlineLines = memoryIndexLines(ranked)

  /** Base identity line sets, most complete first. The root line is in every one. */
  const bases: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
    [...named, rootField, ...stack],
    [...named, rootField],
    [rootField],
  ]

  for (const fields of bases) {
    const labels = fields.map(([label, value]) => `${label}: ${value}`)
    // Headlines shed before the catalog, and the catalog before any identity
    // line: the catalog is what tells the model that unshown entries exist, so it
    // is worth more than a single headline.
    for (const withCatalog of [true, false]) {
      for (let shown = headlineLines.length; shown >= 0; shown--) {
        const headlines = headlineLines.slice(0, shown)
        if (byteLength(headlines.join('\n')) > budget.maxIndexBytes) continue
        // The catalog reports what is on screen, not what was ranked: claiming a
        // headline that was shed would misstate what the model can see.
        const catalog = withCatalog ? catalogLine(entries, shown) : undefined
        const lines = [
          ...labels,
          ...catalog === undefined ? [] : [catalog],
          ...headlines,
        ]
        const text = [OPEN_TAG, ...lines, CLOSE_TAG].join('\n')
        if (byteLength(text) <= budget.maxIdentityBytes) return text
      }
    }
  }
  return ''
}

/**
 * Digest a rendered block, for tests and diagnostics only.
 *
 * @param text - The rendered block.
 * @returns Lowercase hex SHA-256 of the UTF-8 bytes.
 */
export function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
