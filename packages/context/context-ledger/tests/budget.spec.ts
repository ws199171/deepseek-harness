import { describe, expect, it } from 'vitest'
import {
  BUDGET_CEILING_KEYS,
  BUDGET_PROFILE_NAMES,
  BUDGET_PROFILES,
  BUDGET_RUNG_NAMES,
  DEFAULT_ADAPTIVE_RATIO,
  DEFAULT_BUDGET_PROFILE,
  IDENTITY_ONLY_RUNG,
  budgetForRung,
  resolveAdaptiveRung,
  resolveBudget,
  resolveSessionBudget,
} from '../src/budget.ts'

describe('the profile tables', () => {
  it('makes the default a rung, and adaptive selectable but not a rung', () => {
    expect([...BUDGET_RUNG_NAMES]).toContain(DEFAULT_BUDGET_PROFILE)
    expect([...BUDGET_RUNG_NAMES]).toEqual(Object.keys(BUDGET_PROFILES))
    expect([...BUDGET_PROFILE_NAMES]).toEqual([...BUDGET_RUNG_NAMES, 'adaptive'])
    expect([...BUDGET_RUNG_NAMES]).not.toContain('adaptive')
  })

  it('declares exactly the same ceiling keys in every profile', () => {
    for (const [name, profile] of Object.entries(BUDGET_PROFILES)) {
      expect(Object.keys(profile).sort(), name).toEqual([...BUDGET_CEILING_KEYS].sort())
    }
  })

  it('is wider on every ceiling as the rungs widen', () => {
    for (const key of BUDGET_CEILING_KEYS) {
      expect(BUDGET_PROFILES.frugal[key], `${key}: frugal < balanced`).toBeLessThan(BUDGET_PROFILES.balanced[key])
      expect(BUDGET_PROFILES.balanced[key], `${key}: balanced < full`).toBeLessThan(BUDGET_PROFILES.full[key])
    }
  })
})

describe('resolveBudget', () => {
  it('fills the default profile when nothing is configured', () => {
    const budget = resolveBudget(undefined)
    expect(budget.profile).toBe(DEFAULT_BUDGET_PROFILE)
    for (const key of BUDGET_CEILING_KEYS) {
      expect(budget[key], key).toBe(BUDGET_PROFILES[DEFAULT_BUDGET_PROFILE][key])
    }
  })

  it('selects a named profile', () => {
    const budget = resolveBudget({ profile: 'frugal' })
    expect(budget.profile).toBe('frugal')
    expect(budget.maxIndexEntries).toBe(BUDGET_PROFILES.frugal.maxIndexEntries)
  })

  it('lets an override win over the profile it is applied to', () => {
    const budget = resolveBudget({ profile: 'frugal', overrides: { maxIndexEntries: 99 } })
    expect(budget.maxIndexEntries).toBe(99)
    expect(budget.maxIdentityBytes).toBe(BUDGET_PROFILES.frugal.maxIdentityBytes)
  })

  it('returns a frozen budget independent of the profile table', () => {
    const budget = resolveBudget({ profile: 'full', overrides: { maxEntryBytes: 7 } })
    expect(Object.isFrozen(budget)).toBe(true)
    expect(budget.maxEntryBytes).toBe(7)
    expect(BUDGET_PROFILES.full.maxEntryBytes).not.toBe(7)
  })

  it('rejects an unknown profile rather than silently defaulting', () => {
    expect(() => resolveBudget({ profile: 'generous' })).toThrow(TypeError)
  })

  it('rejects an unknown override key rather than ignoring it', () => {
    expect(() => resolveBudget({ overrides: { maxTokens: 500 } })).toThrow(TypeError)
  })

  it('treats zero as a usable ceiling meaning none, and rejects negative or fractional ones', () => {
    expect(resolveBudget({ overrides: { maxIndexEntries: 0 } }).maxIndexEntries).toBe(0)
    expect(() => resolveBudget({ overrides: { maxIndexEntries: -3 } })).toThrow(RangeError)
    expect(() => resolveBudget({ overrides: { maxIndexEntries: 1.5 } })).toThrow(RangeError)
  })

  it('refuses the adaptive profile when fixed ceilings are asked for', () => {
    expect(() => resolveBudget({ profile: 'adaptive' })).toThrow(TypeError)
  })
})

describe('budgetForRung', () => {
  it('keeps the identity block at the floor and drops the headlines', () => {
    const floor = budgetForRung({ rung: IDENTITY_ONLY_RUNG })
    expect(floor.profile).toBe(IDENTITY_ONLY_RUNG)
    expect(floor.maxIndexEntries).toBe(0)
    expect(floor.maxIndexBytes).toBe(0)
    expect(floor.maxIdentityBytes).toBe(BUDGET_PROFILES.frugal.maxIdentityBytes)
  })

  it('accepts overrides like any profile, and rejects an unknown rung', () => {
    const budget = budgetForRung({ rung: 'frugal', overrides: { maxIdentityBytes: 777 } })
    expect(budget.maxIdentityBytes).toBe(777)
    expect(budget.profile).toBe('frugal')
    expect(() => budgetForRung({ rung: 'generous' })).toThrow(TypeError)
  })
})

describe('resolveAdaptiveRung', () => {
  const at = (usedTokens: number | undefined, contextWindow: number | undefined) =>
    resolveAdaptiveRung({ usedTokens, contextWindow, ratio: DEFAULT_ADAPTIVE_RATIO })

  it('widens as the free window grows', () => {
    // Available budget is (window - used) * ratio.
    expect(at(0, 200_000)).toBe('full') // 10_000 available
    expect(at(0, 60_000)).toBe('balanced') // 3_000 available
    expect(at(0, 20_000)).toBe('frugal') // 1_000 available
    expect(at(0, 100)).toBe(IDENTITY_ONLY_RUNG) // 5 available
    expect(at(199_999, 200_000)).toBe(IDENTITY_ONLY_RUNG)
  })

  it('narrows as the session fills', () => {
    const wide = resolveAdaptiveRung({ usedTokens: 0, contextWindow: 200_000, ratio: 0.05 })
    const narrow = resolveAdaptiveRung({ usedTokens: 190_000, contextWindow: 200_000, ratio: 0.05 })
    expect(wide).toBe('full')
    expect(narrow).toBe(IDENTITY_ONLY_RUNG)
  })

  it('falls back to the default profile when the window is unmeasurable', () => {
    const requests = [
      { usedTokens: undefined, contextWindow: 200_000, ratio: 0.05 },
      { usedTokens: 10, contextWindow: undefined, ratio: 0.05 },
      { usedTokens: Number.NaN, contextWindow: 200_000, ratio: 0.05 },
      { usedTokens: 10, contextWindow: 200_000, ratio: Number.NaN },
      { usedTokens: 10, contextWindow: 200_000, ratio: 0 },
    ]
    for (const request of requests) {
      expect(resolveAdaptiveRung(request), JSON.stringify(request)).toBe(DEFAULT_BUDGET_PROFILE)
    }
  })

  it('treats a used count beyond the window as no room, not as negative room', () => {
    expect(resolveAdaptiveRung({ usedTokens: 500_000, contextWindow: 200_000, ratio: 0.05 }))
      .toBe(IDENTITY_ONLY_RUNG)
  })
})

describe('resolveSessionBudget', () => {
  it('composes a static profile and an adaptive one the same way', () => {
    expect(resolveSessionBudget({ profile: 'frugal', overrides: {} }).rung).toBe('frugal')

    const adaptive = resolveSessionBudget({
      profile: 'adaptive',
      overrides: {},
      ratio: 0.05,
      usedTokens: 0,
      contextWindow: 200_000,
    })
    expect(adaptive.rung).toBe('full')
    expect(adaptive.budget.maxIdentityBytes).toBe(BUDGET_PROFILES.full.maxIdentityBytes)

    const unmeasured = resolveSessionBudget({ profile: 'adaptive', overrides: {}, usedTokens: undefined })
    expect(unmeasured.rung).toBe(DEFAULT_BUDGET_PROFILE)
  })

  it('applies overrides to an adaptive rung too', () => {
    const resolved = resolveSessionBudget({
      profile: 'adaptive',
      overrides: { maxIdentityBytes: 999 },
      ratio: 0.05,
      usedTokens: 0,
      contextWindow: 200_000,
    })
    expect(resolved.rung).toBe('full')
    expect(resolved.budget.maxIdentityBytes).toBe(999)
  })
})
