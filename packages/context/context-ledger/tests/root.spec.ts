import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findProjectRoot, probeManifests, probePath } from '../src/root.ts'
import { failingFileSystem, nodeFileSystem } from './helpers/node-fs-provider.ts'

let scratch = ''
const fileSystem = nodeFileSystem()

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'context-ledger-root-'))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('findProjectRoot', () => {
  it('returns the nearest ancestor carrying a marker, not the session directory', async () => {
    const project = join(scratch, 'nearest', 'project')
    const nested = join(project, 'packages', 'inner', 'src')
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(nested, { recursive: true })

    const found = await findProjectRoot({ cwd: nested, markers: ['.git'], fileSystem, signal: undefined })

    expect(found.root).toBe(resolve(project))
    expect(found.hasMarker).toBe(true)
  })

  it('reports cwd with hasMarker false instead of claiming a project', async () => {
    const plain = join(scratch, 'no-marker', 'nested')
    await mkdir(plain, { recursive: true })

    const found = await findProjectRoot({ cwd: plain, markers: ['.git'], fileSystem, signal: undefined })

    expect(found.root).toBe(resolve(plain))
    expect(found.hasMarker).toBe(false)
  })

  it('counts a .git file as a marker, as it does for a worktree or submodule', async () => {
    const project = join(scratch, 'worktree')
    const nested = join(project, 'src')
    await mkdir(nested, { recursive: true })
    await writeFile(join(project, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n')

    const found = await findProjectRoot({ cwd: nested, markers: ['.git'], fileSystem, signal: undefined })

    expect(found.root).toBe(resolve(project))
    expect(found.hasMarker).toBe(true)
  })

  it('terminates at the filesystem root without throwing', async () => {
    const found = await findProjectRoot({
      cwd: resolve('/'),
      markers: ['context-ledger-definitely-absent-marker'],
      fileSystem,
      signal: undefined,
    })
    expect(found.hasMarker).toBe(false)
  })
})

describe('probeManifests', () => {
  it('reports presence, size, and the provider change token, in the configured order', async () => {
    const project = join(scratch, 'manifests')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'package.json'), '{"name":"demo"}\n')

    const probes = await probeManifests({
      projectRoot: project,
      names: ['package.json', 'Cargo.toml'],
      fileSystem,
      signal: undefined,
    })

    expect(probes.map(probe => probe.name)).toEqual(['package.json', 'Cargo.toml'])
    expect(probes.map(probe => probe.present)).toEqual([true, false])

    const present = probes.find(probe => probe.name === 'package.json')
    expect(present?.size).toBe(Buffer.byteLength('{"name":"demo"}\n'))
    expect(typeof present?.version).toBe('string')

    // A manifest that is not there carries neither figure: absence is the signal,
    // and reporting a size for it would invite a caller to read one.
    const absent = probes.find(probe => probe.name === 'Cargo.toml')
    expect('size' in (absent ?? {})).toBe(false)
    expect('version' in (absent ?? {})).toBe(false)
  })
})

describe('probePath', () => {
  it('reports an absent path as not present rather than throwing', async () => {
    const probe = await probePath(fileSystem, join(scratch, 'absent'), undefined)
    expect(probe).toEqual({ present: false })
  })

  it('propagates a failure that is not a missing path instead of reading as absent', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    await expect(probePath(failingFileSystem(denied), join(scratch, 'anything'), undefined))
      .rejects.toThrow(/permission denied/)
  })
})

describe('probePath without a change token', () => {
  it('omits the token when the provider reports only a size', async () => {
    const sizeOnly = {
      async resolve(path: string) { return path },
      async stat() { return { size: 5 } },
      async readText() { return '' },
    }
    expect(await probePath(sizeOnly, join(scratch, 'anything'), undefined)).toEqual({ present: true, size: 5 })
  })
})
