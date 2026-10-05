/**
 * Platform-constraint guards.
 *
 * These are not style checks. A third-party plugin cannot append a session
 * event of its own type — the writer offers no way to mark it ignorable — so a
 * plugin that does it can leave a session future builds refuse to reopen. And a
 * changing system-prompt *section* replaces the prompt's first surface node,
 * which invalidates the cacheable prefix. Both are checked against the shipped
 * source because they are properties of what is written, not of one behavior.
 * @module @deepseek-ai/dsh-orchestration-sentinel/tests/platform-guards
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { inject } from '../src/index.ts'

/** Every source module of the plugin, in the order a reader would meet them. */
const SOURCES = ['index.ts', 'config.ts', 'state.ts', 'guidance.ts', 'decide.ts']

/**
 * Read one plugin source module.
 * @param name - file name under `src/`.
 * @returns the file's text.
 */
async function source(name: string): Promise<string> {
  return await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')
}

describe('platform guards', () => {
  it('appends no session event of its own type', async () => {
    for (const name of SOURCES) {
      expect(await source(name), name).not.toMatch(/\.append\(/u)
      expect(await source(name), name).not.toMatch(/SessionWriter|session\.append/u)
    }
  })

  it('registers no system-prompt section', async () => {
    for (const name of SOURCES) {
      expect(await source(name), name).not.toMatch(/systemPrompt\.section/u)
    }
  })

  it('declares exactly the services it cannot run without', () => {
    expect([...inject].sort()).toEqual(['sessionProjections', 'systemPrompt', 'tools'])
  })
})
