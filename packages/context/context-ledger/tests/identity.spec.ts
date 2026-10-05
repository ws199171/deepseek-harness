import { describe, expect, it } from 'vitest'
import { resolveBudget } from '../src/budget.ts'
import { createEntry, type Entry } from '../src/entry.ts'
import { catalogLine, digestOf, memoryIndexLines, presentManifests, renderIdentity } from '../src/identity.ts'

const ROOT = '/work/demo'
const FULL = [
  '<project_context>',
  'Project: demo',
  `Root: ${ROOT}`,
  'Stack: package.json',
  '</project_context>',
].join('\n')
const WITHOUT_STACK = [
  '<project_context>',
  'Project: demo',
  `Root: ${ROOT}`,
  '</project_context>',
].join('\n')
const ROOT_ONLY = ['<project_context>', `Root: ${ROOT}`, '</project_context>'].join('\n')
const ROOT_AND_STACK = [
  '<project_context>',
  `Root: ${ROOT}`,
  'Stack: package.json',
  '</project_context>',
].join('\n')

const STACK = ['package.json']

/**
 * Build a budget with wide identity and index ceilings, optionally overriding one.
 *
 * @param overrides - Ceiling overrides.
 * @returns The budget.
 */
function budget(overrides: Record<string, number> = {}) {
  return resolveBudget({ overrides: { maxIdentityBytes: 4096, maxIndexBytes: 2048, ...overrides } })
}

/**
 * Build a confirmed fact.
 *
 * @param title - The fact's headline.
 * @param overrides - Fields to replace.
 * @returns The entry.
 */
function fact(title: string, overrides: Partial<Entry> = {}): Entry {
  return { ...createEntry({ kind: 'decision', title, body: 'body', now: 1 }), tier: 'confirmed', ...overrides }
}

describe('presentManifests', () => {
  it('keeps only existing manifests, in the configured order', () => {
    expect(presentManifests([
      { name: 'package.json', present: true, size: 1, version: 'v' },
      { name: 'Cargo.toml', present: false },
      { name: 'go.mod', present: true, size: 2, version: 'w' },
    ])).toEqual(['package.json', 'go.mod'])
    expect(presentManifests([])).toEqual([])
  })
})

describe('the shedding fixtures', () => {
  it('are the sizes the shedding tests assume', () => {
    expect(Buffer.byteLength(FULL, 'utf8')).toBe(87)
    expect(Buffer.byteLength(WITHOUT_STACK, 'utf8')).toBe(67)
    expect(Buffer.byteLength(ROOT_ONLY, 'utf8')).toBe(53)
    expect(Buffer.byteLength(ROOT_AND_STACK, 'utf8')).toBe(73)
  })
})

describe('renderIdentity', () => {
  it('renders identity only, saying nothing about memory, when nothing is recorded', () => {
    const text = renderIdentity({
      projectRoot: ROOT,
      includeProjectName: true,
      presentManifests: STACK,
      entries: [],
      budget: budget(),
    })
    expect(text).toBe(FULL)
    expect(text).not.toContain('Memory:')
  })

  it('gives a confirmed entry a headline and a catalog line', () => {
    const text = renderIdentity({
      projectRoot: ROOT,
      includeProjectName: true,
      presentManifests: STACK,
      entries: [fact('Use pnpm, not npm')],
      budget: budget(),
    })
    expect(text).toBe([
      '<project_context>',
      'Project: demo',
      `Root: ${ROOT}`,
      'Stack: package.json',
      'Memory: 1 recorded, 1 shown (decision 1)',
      '- [decision] Use pnpm, not npm',
      '</project_context>',
    ].join('\n'))
  })

  it('counts an unconfirmed entry but never injects it', () => {
    const text = renderIdentity({
      projectRoot: ROOT,
      includeProjectName: true,
      presentManifests: STACK,
      entries: [fact('Not yet approved', { tier: 'auto' })],
      budget: budget(),
    })
    expect(text).toContain('Memory: 1 recorded, 0 shown (decision 1)')
    expect(text).not.toContain('- [decision] Not yet approved')
  })

  it('injects only the title, never the body', () => {
    const text = renderIdentity({
      projectRoot: ROOT,
      includeProjectName: true,
      presentManifests: STACK,
      entries: [fact('A title', { body: 'SECRET-BODY-TEXT' })],
      budget: budget(),
    })
    expect(text).toContain('- [decision] A title')
    expect(text).not.toContain('SECRET-BODY-TEXT')
  })

  it('reports in the catalog how many entries missed a slot', () => {
    const text = renderIdentity({
      projectRoot: ROOT,
      includeProjectName: true,
      presentManifests: STACK,
      entries: [fact('One'), fact('Two'), fact('Three')],
      budget: budget({ maxIndexEntries: 1 }),
    })
    expect(text).toContain('Memory: 3 recorded, 1 shown')
    expect(text.split('\n').filter(line => line.startsWith('- '))).toHaveLength(1)
  })

  it('excludes a headline too long for the headline ceiling while still counting it', () => {
    const text = renderIdentity({
      projectRoot: ROOT,
      includeProjectName: true,
      presentManifests: STACK,
      entries: [fact('x'.repeat(60))],
      budget: budget({ maxIndexEntryBytes: 20 }),
    })
    expect(text).toContain('Memory: 1 recorded, 0 shown')
    expect(text).not.toContain('- [decision]')
  })

  it('sheds headlines under an index ceiling while keeping the catalog honest', () => {
    const text = renderIdentity({
      projectRoot: ROOT,
      includeProjectName: true,
      presentManifests: STACK,
      entries: [fact('One'), fact('Two'), fact('Three')],
      budget: budget({ maxIndexBytes: 1 }),
    })
    // Raising the ceiling would not help; the headlines are shed, so the catalog
    // must report zero shown rather than the number that were ranked.
    expect(text).toContain('Memory: 3 recorded, 0 shown')
    expect(text.split('\n').filter(line => line.startsWith('- '))).toHaveLength(0)
  })

  it('sheds the stack, then the project name, then everything, under a tight block ceiling', () => {
    const base = { projectRoot: ROOT, presentManifests: STACK, entries: [] }
    expect(renderIdentity({ ...base, includeProjectName: true, budget: budget({ maxIdentityBytes: 87 }) })).toBe(FULL)
    expect(renderIdentity({ ...base, includeProjectName: true, budget: budget({ maxIdentityBytes: 86 }) })).toBe(WITHOUT_STACK)
    expect(renderIdentity({ ...base, includeProjectName: false, budget: budget({ maxIdentityBytes: 73 }) })).toBe(ROOT_AND_STACK)
    expect(renderIdentity({ ...base, includeProjectName: false, budget: budget({ maxIdentityBytes: 53 }) })).toBe(ROOT_ONLY)
    expect(renderIdentity({ ...base, includeProjectName: false, budget: budget({ maxIdentityBytes: 52 }) })).toBe('')
  })

  it('drops the catalog and headlines before the identity lines', () => {
    const input = { projectRoot: ROOT, includeProjectName: true, presentManifests: STACK, entries: [fact('One')] }
    expect(renderIdentity({ ...input, budget: budget() })).toContain('Memory:')
    expect(renderIdentity({ ...input, budget: budget({ maxIdentityBytes: 87 }) })).toBe(FULL)
  })

  it('is byte-stable and emits LF with no trailing newline', () => {
    const input = {
      projectRoot: ROOT,
      includeProjectName: true,
      presentManifests: STACK,
      entries: [fact('One')],
      budget: budget(),
    }
    const text = renderIdentity(input)
    expect(text).toBe(renderIdentity(input))
    expect(text.endsWith('\n')).toBe(false)
    expect(text).not.toContain('\r')
    expect(digestOf(text)).toBe(digestOf(renderIdentity(input)))
  })

  it('changes the block when the manifest set changes', () => {
    const base = { projectRoot: ROOT, includeProjectName: true, entries: [], budget: budget() }
    expect(renderIdentity({ ...base, presentManifests: [] })).toBe(WITHOUT_STACK)
    expect(renderIdentity({ ...base, presentManifests: STACK }))
      .not.toBe(renderIdentity({ ...base, presentManifests: [] }))
  })
})

describe('catalogLine and memoryIndexLines', () => {
  it('omits the catalog only when nothing is recorded', () => {
    expect(catalogLine([], 0)).toBeUndefined()
    expect(catalogLine([fact('One')], 0)).toBe('Memory: 1 recorded, 0 shown (decision 1)')
    expect(catalogLine([fact('One'), fact('Two', { kind: 'build', title: 'Two' })], 2))
      .toBe('Memory: 2 recorded, 2 shown (build 1, decision 1)')
  })

  it('carries the kind and title only', () => {
    expect(memoryIndexLines([fact('Tests need a flag', { kind: 'pitfall', body: 'x', id: 'i' })]))
      .toEqual(['- [pitfall] Tests need a flag'])
  })
})
