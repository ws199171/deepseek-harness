import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { describe, expect, it } from 'vitest'
import {
  BUDGET_PROFILES,
  DEFAULT_BUDGET_PROFILE,
  type BudgetCeilingKey,
  type BudgetProfileName,
} from '../src/budget.ts'
import { Config, DEFAULTS, resolveConfig } from '../src/config.ts'

describe('resolveConfig defaults', () => {
  it('applies every default when the loader supplies no config', () => {
    const resolved = resolveConfig(undefined)
    expect(resolved.enabled).toBe(true)
    expect(resolved.contextOrder).toBe(100)
    expect([...resolved.projectRootMarkers]).toEqual(['.git'])
    expect([...resolved.stackManifestNames]).toEqual(['package.json'])
    expect(resolved.includeProjectName).toBe(true)
    expect(resolved.ledgerHome).toBe(resolveDshHome())
    expect(resolved.budget.profile).toBe(DEFAULT_BUDGET_PROFILE)
  })

  it('carries every ceiling of the selected profile', () => {
    const resolved = resolveConfig({ budgetProfile: 'full' })
    for (const [key, value] of Object.entries(BUDGET_PROFILES.full)) {
      expect(resolved.budget[key as BudgetCeilingKey], key).toBe(value)
    }
  })

  it('lets budget overrides reach the resolved ceilings', () => {
    const resolved = resolveConfig({ budgetProfile: 'frugal', budgetOverrides: { maxIndexEntries: 42 } })
    expect(resolved.budget.maxIndexEntries).toBe(42)
    expect(resolved.budget.maxIdentityBytes).toBe(BUDGET_PROFILES.frugal.maxIdentityBytes)
  })

  it('returns a frozen value whose lists cannot be mutated in place', () => {
    const resolved = resolveConfig({})
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.projectRootMarkers)).toBe(true)
    expect(Object.isFrozen(resolved.stackManifestNames)).toBe(true)
    expect(Object.isFrozen(resolved.budget)).toBe(true)
  })

  it('honours an explicit ledger home', () => {
    expect(resolveConfig({ ledgerHome: '/tmp/ledger' }).ledgerHome).toBe('/tmp/ledger')
    expect(resolveConfig({}).ledgerHome).not.toBe('/tmp/ledger')
  })

  it('honours explicit values and keeps false distinct from absent', () => {
    const resolved = resolveConfig({
      enabled: false,
      contextOrder: -5,
      projectRootMarkers: ['Cargo.toml'],
      stackManifestNames: ['Cargo.toml', 'Cargo.lock'],
      includeProjectName: false,
    })
    expect(resolved.enabled).toBe(false)
    expect(resolved.contextOrder).toBe(-5)
    expect([...resolved.projectRootMarkers]).toEqual(['Cargo.toml'])
    expect([...resolved.stackManifestNames]).toEqual(['Cargo.toml', 'Cargo.lock'])
    expect(resolved.includeProjectName).toBe(false)
  })
})

describe('resolveConfig rejections', () => {
  it('rejects a non-finite contextOrder', () => {
    expect(() => resolveConfig({ contextOrder: Number.NaN })).toThrow(TypeError)
    expect(() => resolveConfig({ contextOrder: Number.POSITIVE_INFINITY })).toThrow(TypeError)
  })

  it('rejects an empty marker list rather than making every directory a project', () => {
    expect(() => resolveConfig({ projectRootMarkers: [] })).toThrow(RangeError)
  })

  it('rejects an empty manifest list rather than always rendering an empty stack', () => {
    expect(() => resolveConfig({ stackManifestNames: [] })).toThrow(RangeError)
  })

  it('rejects an unknown budget profile at load', () => {
    // An untyped config file can still carry a name outside the union, so the
    // resolver's own check is the one that has to hold.
    const outsideTheUnion = 'generous' as BudgetProfileName
    expect(() => resolveConfig({ budgetProfile: outsideTheUnion })).toThrow(TypeError)
  })

  it('rejects an unknown or unusable budget override at load', () => {
    expect(() => resolveConfig({ budgetOverrides: { maxTokens: 1 } })).toThrow(TypeError)
    expect(() => resolveConfig({ budgetOverrides: { maxIndexEntries: -1 } })).toThrow(RangeError)
  })

  it('rejects an unusable adaptive ratio at load', () => {
    expect(() => resolveConfig({ budgetProfile: 'adaptive', adaptiveUtilizationRatio: 0 })).toThrow(RangeError)
    expect(() => resolveConfig({ budgetProfile: 'adaptive', adaptiveUtilizationRatio: -1 })).toThrow(RangeError)
    expect(() => resolveConfig({ budgetProfile: 'adaptive', adaptiveUtilizationRatio: Number.NaN })).toThrow(RangeError)
  })

  it('rejects an override even under the adaptive profile', () => {
    expect(() => resolveConfig({ budgetProfile: 'adaptive', budgetOverrides: { maxTokens: 1 } })).toThrow(TypeError)
  })
})

describe('the adaptive and static modes', () => {
  it('resolves an adaptive budget at load and carries its ratio', () => {
    const resolved = resolveConfig({ budgetProfile: 'adaptive', adaptiveUtilizationRatio: 0.2 })
    expect(resolved.budgetProfile).toBe('adaptive')
    expect(resolved.adaptiveUtilizationRatio).toBe(0.2)
    // Before the first checkpoint there is no measurement, so the default rung applies.
    expect(resolved.budget.profile).toBe(DEFAULT_BUDGET_PROFILE)
  })

  it('carries a static ratio without using it', () => {
    const resolved = resolveConfig({ budgetProfile: 'full' })
    expect(resolved.budget.profile).toBe('full')
    expect(resolved.adaptiveUtilizationRatio).toBe(DEFAULTS.adaptiveUtilizationRatio)
  })
})

describe('the schema', () => {
  it('agrees with the resolver on every default', () => {
    const fromSchema = Config({})
    expect(fromSchema.enabled).toBe(DEFAULTS.enabled)
    expect(fromSchema.contextOrder).toBe(DEFAULTS.contextOrder)
    expect(fromSchema.projectRootMarkers).toEqual([...DEFAULTS.projectRootMarkers])
    expect(fromSchema.stackManifestNames).toEqual([...DEFAULTS.stackManifestNames])
    expect(fromSchema.includeProjectName).toBe(DEFAULTS.includeProjectName)
    expect(fromSchema.budgetProfile).toBe(DEFAULTS.budgetProfile)
    expect(fromSchema.budgetOverrides).toEqual({})
  })

  it('rejects a value outside the profile union before apply runs', () => {
    // A schema rejects values, not types; a wrong *type* is the compiler's
    // business and cannot reach here at all.
    const outsideTheUnion = 'generous' as BudgetProfileName
    expect(() => Config({ budgetProfile: outsideTheUnion })).toThrow()
  })
})
