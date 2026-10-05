/**
 * Path helpers shared by the parts of the plugin that reason about a session's
 * working directory.
 *
 * These are pure functions over strings: they decide whether a path belongs to a
 * project, never whether it exists. Existence is the filesystem provider's
 * question.
 *
 * @module dsh-context-ledger/paths
 */

import { isAbsolute, relative, resolve as resolvePath } from 'node:path'

/**
 * Resolve a possibly-relative path against the session directory.
 *
 * @param path - The raw path.
 * @param cwd - The session working directory.
 * @returns The absolute path, or `undefined` when it cannot be placed.
 */
export function absolutePathOf(path: string, cwd: string | undefined): string | undefined {
  const trimmed = path.trim()
  if (trimmed.length === 0) return undefined
  if (isAbsolute(trimmed)) return resolvePath(trimmed)
  if (cwd === undefined) return undefined
  return resolvePath(cwd, trimmed)
}

/**
 * Whether one path names a descendant of another, excluding the ancestor itself.
 *
 * @param child - Absolutized candidate path.
 * @param parent - Absolutized ancestor path.
 * @returns True when `child` is strictly inside `parent`.
 */
export function isInside(child: string, parent: string): boolean {
  const relativePath = relative(parent, child)
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

/**
 * Whether one path is an ancestor of another or equal to it.
 *
 * @param candidate - Absolutized candidate ancestor.
 * @param child - Absolutized descendant path.
 * @returns True when `candidate` contains `child`.
 */
export function contains(candidate: string, child: string): boolean {
  return candidate === child || isInside(child, candidate)
}
