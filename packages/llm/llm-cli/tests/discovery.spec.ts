import { describe, expect, it } from 'vitest'
import { CLI_CANDIDATES, discoverAll, candidateOf, parseCodeBuddyModels, where } from '../src/discovery.ts'
import { cliDiscoverResultSchema, cliTestRequestSchema } from '../src/spec.ts'

describe('CLI_CANDIDATES', () => {
  it('exposes supported commands with non-empty ids and commands', () => {
    const ids = new Set<string>()
    for (const candidate of CLI_CANDIDATES) {
      expect(candidate.id.length).toBeGreaterThan(0)
      expect(candidate.displayName.length).toBeGreaterThan(0)
      expect(candidate.commands.length).toBeGreaterThan(0)
      expect(ids.has(candidate.id)).toBe(false)
      ids.add(candidate.id)
    }
    expect(ids).toContain('codebuddy')
    expect(ids).toEqual(new Set(['codebuddy']))
  })

  it('every probe args list uses stream-json output', () => {
    for (const candidate of CLI_CANDIDATES) {
      expect(candidate.probeArgs).toContain('stream-json')
    }
  })
})

describe('where', () => {
  it('returns undefined for a definitely-absent binary', () => {
    expect(where('__definitely_not_a_real_binary_name__')).toBeUndefined()
  })

  it('finds a present binary', () => {
    const path = where('node')
    expect(path).toBeDefined()
  })
})

describe('candidateOf', () => {
  it('returns the matching candidate', () => {
    expect(candidateOf('codebuddy')?.displayName).toBe('CodeBuddy CLI')
  })

  it('returns undefined for unknown ids', () => {
    expect(candidateOf('__nonexistent__')).toBeUndefined()
  })
})

describe('discoverAll', () => {
  it('returns one entry per vendor candidate', async () => {
    const entries = await discoverAll()
    expect(entries.length).toBe(CLI_CANDIDATES.length)
    expect(entries.every(entry => entry.id.length > 0)).toBe(true)
  })
})

describe('schemas', () => {
  it('accepts a well-formed discover result', () => {
    const parsed = cliDiscoverResultSchema.parse({
      entries: [{
        id: 'codebuddy',
        displayName: 'CodeBuddy CLI',
        presence: 'present',
        commands: ['codebuddy'],
        path: '/usr/local/bin/codebuddy',
        version: '2.132.0',
        models: [{ id: 'claude-sonnet-5' }],
        health: 'unknown',
      }],
    })
    void parsed
  })

  it('extracts CodeBuddy model ids from its help listing', () => {
    expect(parseCodeBuddyModels('--model <model> Model. Currently supported: (gpt-5.6-sol, custom-local:deepseek-v4-pro)'))
      .toEqual([{ id: 'gpt-5.6-sol' }, { id: 'custom-local:deepseek-v4-pro' }])
  })

  it('accepts a well-formed test request', () => {
    const parsed = cliTestRequestSchema.parse({
      id: 'codebuddy',
      extraArgs: [],
    })
    void parsed
  })

  it('rejects empty id in test request', () => {
    const result = cliTestRequestSchema.safeParse({ id: '', extraArgs: [] })
    expect(result.success).toBe(false)
  })
})
