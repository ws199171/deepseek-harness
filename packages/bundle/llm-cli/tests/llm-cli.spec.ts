/**
 * The dsh-llm-cli-bundle's declared rows: the CLI route it inserts, the HTTP
 * provider rows it turns off, and the default-model row it re-points. The
 * package's whole substance is that patch list, so the tests pin it exactly
 * rather than exercising a runtime surface it does not have.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

/** The package segment of a plugin specifier, subpath removed. */
function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

/** One parsed patch entry, as the composer reads it. */
interface PatchEntry {
  id?: string
  name?: string
  inject?: string[]
  config?: Record<string, unknown>
  disabled?: unknown
  insert?: Array<{ id?: string; name?: string; config?: Record<string, unknown> }>
}

/** This package's manifest, as the patch tests read it. */
interface Manifest {
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

/** The manifest plus the patch list it declares. */
interface LoadedPatch {
  manifest: Manifest
  patches: PatchEntry[]
}

/** Load this package's manifest and its declared patch list. */
function loadPatch(): LoadedPatch {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest
  const patches = yaml.load(
    readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
    { schema: entryListSchema },
  ) as PatchEntry[]
  return { manifest, patches }
}

describe('dsh-llm-cli-bundle', () => {
  it('inserts the CLI route and clamps each HTTP provider row by id', () => {
    const { manifest, patches } = loadPatch()
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')

    // One insert plus one addressing patch per reused row.
    expect(patches.map(entry => (entry.insert === undefined ? entry.id : 'insert'))).toEqual([
      'insert',
      'llm-deepseek',
      'llm-deepseek-account',
      'llm-pi-ai',
      'agent-default-model',
    ])
    expect(patches[0]?.insert?.map(row => [row.id, row.name])).toEqual([
      ['llm-cli', '@deepseek-ai/dsh-llm-cli'],
    ])
  })

  it('mounts the CLI route with the stream-json invocation and a non-interactive policy', () => {
    const { patches } = loadPatch()
    expect(patches[0]?.insert?.[0]?.config).toEqual({
      command: 'codebuddy',
      // The trailing positional prompt is the only channel this CLI reads, so
      // the base invocation must put it on stdout as stream-json.
      args: ['--print', '--output-format', 'stream-json'],
      // CodeBuddy's print mode has no approval channel; without a
      // non-interactive policy its own tool calls are refused instead of run.
      permissionMode: 'bypassPermissions',
    })
  })

  it('turns off every row that resolves a key and reaches an endpoint', () => {
    const { patches } = loadPatch()
    const disabled = patches.filter(entry => entry.disabled === true).map(entry => entry.id)
    // Each one is named exactly, so a new HTTP provider row added to dsh-base
    // cannot silently stay mounted beside the CLI route.
    expect(disabled).toEqual(['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai'])
    // A row patch carries no name: it addresses the row dsh-base already mounted.
    for (const entry of patches.filter(candidate => candidate.id !== undefined)) {
      expect(entry.name).toBeUndefined()
    }
  })

  it('re-points the default Agent model at the CLI route, with an environment override', () => {
    const { patches } = loadPatch()
    const row = patches.find(entry => entry.id === 'agent-default-model')
    expect(row?.config).toEqual({
      provider: 'codebuddy-cli',
      model: { __jsExpr: "process.env.DSH_CLI_MODEL ?? 'default'" },
    })
  })

  it('declares every package its inserted rows mount', () => {
    const { manifest, patches } = loadPatch()
    // Addressing patches reuse dsh-base's rows, so only inserted rows own a
    // dependency; the manifest must still name each one so the row resolves.
    const mounted = new Set(
      (patches.flatMap(entry => entry.insert ?? []).map(row => row.name))
        .filter((name): name is string => name !== undefined)
        .map(packageName),
    )
    expect([...mounted].sort()).toEqual(['@deepseek-ai/dsh-llm-cli'])
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([...mounted].sort())
  })
})
