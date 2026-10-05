/**
 * A test-only filesystem provider over `node:fs/promises`.
 *
 * The plugin never imports `node:fs` itself: it reads the provider from
 * `ctx.get('fs')` so it cannot reach around a sandbox or a remote host.
 * Exercising the walk against real directories therefore needs a concrete
 * provider, and this adapter implements the same structural contract — `resolve`
 * maps a host path to a provider target, and `stat` resolves `undefined` for a
 * missing path while rejecting for any other failure.
 *
 * @module @deepseek-ai/dsh-context-ledger/tests/helpers/node-fs-provider
 */

import { readFile, stat } from 'node:fs/promises'

/** What a test provider must expose: the path-probe seam plus convention reads. */
export interface TestFileSystem {
  /** Map a host path to this provider's target, which is the path itself. */
  resolve: (path: string, options?: { signal?: AbortSignal }) => Promise<string>
  /** Describe a path, or answer `undefined` when it does not exist. */
  stat: (path: string, signal?: AbortSignal) => Promise<{ size?: number; version?: string } | undefined>
  /** Read a file's text, for the convention path. */
  readText: (path: string, signal?: AbortSignal) => Promise<string>
}

/**
 * Build a provider backed by the host filesystem.
 *
 * @returns The provider.
 */
export function nodeFileSystem(): TestFileSystem {
  return {
    async resolve(path) {
      return path
    },
    async stat(path, signal) {
      // `node:fs` stat() takes no cancellation signal, so this adapter honours the
      // caller's cancellation only between its calls. A test adapter needs no more.
      void signal
      try {
        const info = await stat(path)
        return info.isDirectory()
          ? { version: `directory:${info.mtimeMs}` }
          : { size: info.size, version: `file:${info.mtimeMs}:${info.size}` }
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT' || (error as { code?: string }).code === 'ENOTDIR') {
          return undefined
        }
        throw error
      }
    },
    async readText(path, signal) {
      return readFile(path, signal === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', signal })
    },
  }
}

/**
 * Build a provider where no path exists.
 *
 * @returns The provider.
 */
export function emptyFileSystem(): TestFileSystem {
  return {
    async resolve(path) {
      return path
    },
    async stat() {
      return undefined
    },
    async readText() {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    },
  }
}

/**
 * Build a provider whose every probe fails, to exercise error propagation.
 *
 * @param error - The failure to raise.
 * @returns The provider.
 */
export function failingFileSystem(error: Error): TestFileSystem {
  return {
    async resolve(path) {
      return path
    },
    async stat() {
      throw error
    },
    async readText() {
      throw error
    },
  }
}
