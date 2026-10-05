/**
 * The handoff brief.
 *
 * A brief is what a fresh session needs that it cannot get on its own. It is
 * deliberately *not* a summary: it is the mechanical record of what recent
 * sessions did, plus a pointer at the facts every session of this project
 * already receives. Nothing here is inferred or paraphrased, so a brief cannot
 * disagree with the archive it came from.
 *
 * Facts are dropped first when the ceiling binds, because a session started in
 * the same project receives them automatically — they are the only part of the
 * brief that is genuinely redundant at its destination.
 *
 * @module dsh-context-ledger/brief
 */

import type { ArchiveRow } from './archive.ts'
import type { BudgetSpec } from './budget.ts'
import type { Entry } from './entry.ts'

/** Everything the brief is rendered from. */
export interface BriefInput {
  /** The resolved project root. */
  readonly projectRoot: string
  /** Archive rows, most recent first. */
  readonly rows: readonly ArchiveRow[]
  /** The entries that receive an injected headline. */
  readonly facts: readonly Entry[]
  /** The resolved ceilings. */
  readonly budget: BudgetSpec
}

/**
 * Byte length of a string as UTF-8, which is what the ceiling is expressed in.
 *
 * @param text - The text to measure.
 * @returns Its UTF-8 byte length.
 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Render one archive row as a line, optionally listing the paths it touched.
 *
 * @param row - The archived row.
 * @param withPaths - Whether to include the path list.
 * @returns The row's lines.
 */
function rowLines(row: ArchiveRow, withPaths: boolean): string[] {
  const parts = [
    row.sessionId,
    new Date(row.endedAt).toISOString(),
    `${row.turns} turn${row.turns === 1 ? '' : 's'}`,
    `${row.toolCalls} tool call${row.toolCalls === 1 ? '' : 's'}`,
  ]
  if (row.compactions > 0) parts.push(`${row.compactions} compaction${row.compactions === 1 ? '' : 's'}`)
  if (row.lastTurnReason !== undefined) parts.push(`last turn ${row.lastTurnReason}`)
  if (row.pathsTouchedTotal > 0) {
    parts.push(row.pathsTouchedTotal > row.pathsTouched.length
      ? `${row.pathsTouched.length} of ${row.pathsTouchedTotal} paths`
      : `${row.pathsTouchedTotal} path${row.pathsTouchedTotal === 1 ? '' : 's'}`)
  }
  const lines = [`- ${parts.join(' · ')}`]
  if (withPaths && row.pathsTouched.length > 0) {
    lines.push(`  ${row.pathsTouched.join(', ')}`)
  }
  return lines
}

/**
 * Render the brief, shedding the least valuable content before failing the ceiling.
 *
 * The shedding order is fixed and documented: the facts list, then the path
 * lists, then every row but the most recent, and finally everything but the
 * header and the closing instruction. Nothing is truncated mid-value.
 *
 * @param input - The values to render.
 * @returns The brief, or `''` when even the header cannot fit.
 */
export function renderBrief(input: BriefInput): string {
  const { projectRoot, rows, facts, budget } = input
  const header = `Handoff brief for project ${projectRoot}.`
  const footer = [
    'Start a new session in this project rather than continuing this one.',
    'It receives the project block and the confirmed facts automatically, so this brief only adds what recent sessions did.',
  ].join(' ')

  if (byteLength(`${header}\n\n${footer}`) > budget.maxBriefBytes) return ''

  const factsSection = facts.length === 0 ? [] : [
    'Facts every session of this project already receives:',
    ...facts.map(entry => `- [${entry.kind}] ${entry.title}`),
  ]

  /**
   * Candidates from richest to leanest, each dropping exactly one thing from the
   * one above it. Listing them explicitly is what keeps the shedding order the
   * documented one rather than whatever the loops happen to produce.
   */
  const newest = rows[0]
  const candidates: Array<{ rowBlock: string[]; includesFacts: boolean }> = [
    { rowBlock: rows.flatMap(row => rowLines(row, true)), includesFacts: true },
    { rowBlock: rows.flatMap(row => rowLines(row, true)), includesFacts: false },
    { rowBlock: rows.flatMap(row => rowLines(row, false)), includesFacts: false },
    ...rows.length > 1 && newest !== undefined
      ? [{ rowBlock: rowLines(newest, false), includesFacts: false }]
      : [],
    { rowBlock: [], includesFacts: false },
  ]

  for (const { rowBlock, includesFacts } of candidates) {
    const sections = [
      header,
      ...rowBlock.length === 0 ? [] : ['Recent sessions, most recent first:', ...rowBlock],
      ...includesFacts ? factsSection : [],
      footer,
    ]
    const text = sections.join('\n\n')
    if (byteLength(text) <= budget.maxBriefBytes) return text
  }
  // Unreachable: the leanest candidate is the header and footer the guard above
  // already measured against this same ceiling.
  /* v8 ignore next -- the bare candidate always fits once the header does */
  return ''
}
