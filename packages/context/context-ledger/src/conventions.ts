/**
 * Directory-scoped conventions.
 *
 * A `CONTEXT.md` carries task-shaped project knowledge — how to run the tests,
 * which module is being migrated — rather than behavioral instructions, which
 * `dsh-agent-instructions` already owns. It enters the conversation only when a
 * tool result shows that its directory was touched, and only once per session,
 * because a convention's value is highest exactly when the work reaches it and
 * its cost is otherwise a standing tax.
 *
 * Everything here is pure: the caller owns the filesystem reads, the delivery
 * ledger, and the injection.
 *
 * @module dsh-context-ledger/conventions
 */

import { dirname, join, relative } from 'node:path'
import { contains } from './paths.ts'

/** Header the delivered message opens with. */
const HEADER = 'Conventions for directories this session has touched:'

/** One convention file that has already been read. */
export interface ConventionDocument {
  /** Absolute path of the file. */
  readonly path: string
  /** The file's contents. */
  readonly text: string
}

/** What a render included, and what it left out. */
export interface RenderedConventions {
  /** The message text, or `''` when nothing fit. */
  readonly text: string
  /** How many documents the message carries. */
  readonly included: number
  /** How many documents the ceiling left out. */
  readonly omitted: number
}

/**
 * List the convention files that could apply to one touched file.
 *
 * Candidates run from the touched file's own directory up to the project root,
 * nearest first, so the most specific convention is also the first one
 * considered. A file outside the project has no candidates: the ledger speaks for
 * one project only.
 *
 * @param request - The lookup request.
 * @param request.touchedPath - Absolute path of the file a tool touched.
 * @param request.projectRoot - Absolute project root.
 * @param request.fileNames - Configured convention file names.
 * @returns Candidate absolute paths, nearest first.
 */
export function conventionCandidates(request: {
  touchedPath: string
  projectRoot: string
  fileNames: readonly string[]
}): string[] {
  const { touchedPath, projectRoot, fileNames } = request
  const start = dirname(touchedPath)
  if (!contains(projectRoot, start)) return []
  const candidates: string[] = []
  let current = start
  for (;;) {
    for (const name of fileNames) candidates.push(join(current, name))
    if (current === projectRoot) return candidates
    const parent = dirname(current)
    // Unreachable: `contains` above guarantees projectRoot is an ancestor, so
    // this walk meets it before the filesystem root.
    /* v8 ignore next -- the project root is always reached first */
    if (parent === current) return candidates
    current = parent
  }
}

/**
 * Render the delivered message for a set of read convention files.
 *
 * Documents are included nearest-first until the byte ceiling binds, and the ones
 * that did not fit are reported rather than silently dropped — a convention the
 * model was not told about is indistinguishable from one that does not exist.
 *
 * @param request - The render request.
 * @param request.documents - Files already read, nearest first.
 * @param request.projectRoot - Absolute project root, for readable headings.
 * @param request.maxBytes - Ceiling on the rendered message.
 * @returns The message and what it left out.
 */
export function renderConventions(request: {
  documents: readonly ConventionDocument[]
  projectRoot: string
  maxBytes: number
}): RenderedConventions {
  const { documents, projectRoot, maxBytes } = request
  const blocks = documents.map(document => ({
    heading: `## ${relative(projectRoot, document.path) || document.path}`,
    body: document.text.trimEnd(),
  }))
  const included: Array<{ heading: string; body: string }> = []
  let omitted = 0
  for (const [index, block] of blocks.entries()) {
    const candidate = [...included, block]
    if (byteLength(compose(candidate)) > maxBytes) {
      omitted = blocks.length - index
      break
    }
    included.push(block)
  }
  if (included.length === 0) return { text: '', included: 0, omitted: blocks.length }
  const footer = omitted === 0
    ? []
    : [`(${omitted} further convention file${omitted === 1 ? '' : 's'} in these directories ${omitted === 1 ? 'was' : 'were'} too large to include.)`]
  return { text: compose(included, footer), included: included.length, omitted }
}

/**
 * Join the header, the blocks, and the optional footer.
 *
 * @param blocks - Included blocks.
 * @param footer - Closing lines.
 * @returns The message text.
 */
function compose(blocks: ReadonlyArray<{ heading: string; body: string }>, footer: readonly string[] = []): string {
  // Unreachable: both callers pass a non-empty list, and the caller that could
  // pass an empty one returns before it composes.
  /* v8 ignore next -- callers never compose an empty block list */
  if (blocks.length === 0) return ''
  return [
    HEADER,
    ...blocks.flatMap(block => ['', block.heading, block.body]),
    ...footer.flatMap(line => ['', line]),
  ].join('\n')
}

/**
 * Byte length of a string as UTF-8, which is what the ceilings are expressed in.
 *
 * @param text - The text to measure.
 * @returns Its UTF-8 byte length.
 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}
