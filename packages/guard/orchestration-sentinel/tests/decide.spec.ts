/** Decision behavior: the suppression order and both mechanisms. */
import { describe, expect, it } from 'vitest'

import { decide } from '../src/decide.ts'
import type { ConcurrencyKind, DecideView } from '../src/decide.ts'
import { init } from '../src/state.ts'
import type { SentinelState } from '../src/state.ts'
import { testConfig } from './fixtures.ts'

/**
 * Build a state whose steps issued the given calls.
 * @param callsPerStep - one array of tool names per step.
 * @param extra - state fields to replace.
 * @returns the state.
 */
function stateOf(callsPerStep: readonly (readonly string[])[], extra: Partial<SentinelState> = {}): SentinelState {
  return {
    ...init(),
    turn: 1,
    stepIndex: callsPerStep.length,
    steps: callsPerStep.map((names, index) => ({ turn: 1, step: index + 1, names: [...names] })),
    ...extra,
  }
}

/**
 * Build a step view with a name → kind table.
 * @param table - concurrency kind per tool name; unknown names are exclusive.
 * @param overrides - view fields to replace.
 * @returns the view.
 */
function view(table: Record<string, ConcurrencyKind> = { read: 'parallel' }, overrides: Partial<DecideView> = {}): DecideView {
  return {
    turn: 1,
    stepIndex: 3,
    runCodeVisible: false,
    classify: name => table[name] ?? 'exclusive',
    ...overrides,
  }
}

const oneRead = [['read'], ['read'], ['read']]
const sixReads = [['read'], ['read'], ['read'], ['read'], ['read'], ['read']]

describe('decide', () => {
  it('advises batching for a run of single concurrency-safe calls', () => {
    const result = decide(stateOf(oneRead), testConfig(), view())
    expect(result.reason).toBe('split')
    expect(result.text).toContain('turn 1, step 1–3')
    expect(result.text).toContain('these 3 steps each issued exactly one tool call')
  })

  it('stays silent when the run is not entirely concurrency-safe', () => {
    expect(decide(stateOf([['read'], ['read'], ['grep']]), testConfig(),
      view({ read: 'parallel', grep: 'exclusive' }))).toEqual({ text: null, reason: null })
    expect(decide(stateOf([['read'], ['read'], ['mystery']]), testConfig(), view()))
      .toEqual({ text: null, reason: null })
  })

  it('stays silent for a too-short window', () => {
    expect(decide(stateOf([['read'], ['read']]), testConfig(), view())).toEqual({ text: null, reason: null })
    expect(decide(stateOf([]), testConfig(), view())).toEqual({ text: null, reason: null })
  })

  it('honours a single-step streak config', () => {
    expect(decide(stateOf([['read']]), testConfig({ singleCallStreak: 1 }), view(undefined, { stepIndex: 1 })).reason)
      .toBe('split')
  })

  it('treats a multi-call step as compliance, breaking the run', () => {
    expect(decide(stateOf([['read'], ['read'], ['read', 'read']]), testConfig(), view()))
      .toEqual({ text: null, reason: null })
    expect(decide(stateOf([['read'], ['read'], ['read', 'read'], ['read']]), testConfig(), view()))
      .toEqual({ text: null, reason: null })
  })

  it('prefers the PTC suggestion when both mechanisms hold', () => {
    const result = decide(stateOf(sixReads), testConfig({ windowSteps: 6, repeatedToolCalls: 4 }),
      view(undefined, { runCodeVisible: true }))
    expect(result.reason).toBe('ptc')
    expect(result.text).toContain('read has been called 6 times')
    expect(result.text).toContain('turn 1, step 1–6')
  })

  it('requires the transport to be visible, then falls back to batching', () => {
    const config = testConfig({ windowSteps: 6, repeatedToolCalls: 4 })
    expect(decide(stateOf(sixReads), config, view(undefined, { runCodeVisible: false })).reason).toBe('split')
    expect(decide(stateOf(sixReads), Object.assign({}, config, { enablePtcSuggestion: false }),
      view(undefined, { runCodeVisible: true })).reason).toBe('split')
  })

  it('excludes a repeated tool that is not concurrency-safe', () => {
    expect(decide(
      stateOf([['grep'], ['grep'], ['grep'], ['grep']]),
      testConfig({ windowSteps: 4, repeatedToolCalls: 4, enableSplit: false }),
      view({ grep: 'exclusive' }, { runCodeVisible: true }),
    )).toEqual({ text: null, reason: null })
  })

  it('ignores an empty window even when the transport is visible', () => {
    expect(decide(stateOf([]), testConfig({ enableSplit: false }), view(undefined, { runCodeVisible: true })))
      .toEqual({ text: null, reason: null })
  })

  it('counts only inside the configured window', () => {
    expect(decide(stateOf(sixReads), testConfig({ windowSteps: 4, repeatedToolCalls: 5 }),
      view(undefined, { runCodeVisible: true })).reason)
      .toBe('split')

    const spanning = decide(stateOf([['read'], ['read'], ['read'], ['read', 'read', 'read']]),
      testConfig({ windowSteps: 4, repeatedToolCalls: 6, singleCallStreak: 1 }),
      view(undefined, { runCodeVisible: true }))
    expect(spanning.reason).toBe('ptc')
    expect(spanning.text).toContain('step 1–4')
  })

  it('breaks a count tie deterministically by name', () => {
    const result = decide(stateOf([['grep', 'read'], ['grep', 'read']]),
      testConfig({ windowSteps: 2, repeatedToolCalls: 2, enableSplit: false }),
      view({ read: 'parallel', grep: 'parallel' }, { runCodeVisible: true }))
    expect(result.reason).toBe('ptc')
    expect(result.text).toContain('grep has been called 2 times')

    // The mirror insertion order exercises the comparator's other branch: the
    // tally is keyed by name, so only the two orderings reach both sides.
    const mirrored = decide(stateOf([['read', 'grep'], ['read', 'grep']]),
      testConfig({ windowSteps: 2, repeatedToolCalls: 2, enableSplit: false }),
      view({ read: 'parallel', grep: 'parallel' }, { runCodeVisible: true }))
    expect(mirrored.reason).toBe('ptc')
    expect(mirrored.text).toContain('grep has been called 2 times')
  })

  it('orders candidates by count before name', () => {
    const result = decide(stateOf([['read', 'grep'], ['read', 'grep'], ['grep']]),
      testConfig({ windowSteps: 3, repeatedToolCalls: 2, enableSplit: false }),
      view({ read: 'parallel', grep: 'parallel' }, { runCodeVisible: true }))
    expect(result.reason).toBe('ptc')
    expect(result.text).toContain('grep has been called 3 times')
  })

  it('suppresses everything when disabled or out of budget', () => {
    expect(decide(stateOf(oneRead), testConfig({ enabled: false }), view()))
      .toEqual({ text: null, reason: null })
    expect(decide(stateOf(oneRead), testConfig({ maxEmissions: 0 }), view()))
      .toEqual({ text: null, reason: null })
    expect(decide(stateOf(oneRead, { emissions: 3 }), testConfig(), view()))
      .toEqual({ text: null, reason: null })
    expect(decide(stateOf(oneRead, { emissions: 2 }), testConfig(), view()).reason).toBe('split')
  })

  it('applies the cooldown only inside the emitting turn', () => {
    const emitted = { emissions: 1, lastEmitText: 'x', lastEmitTurn: 1, lastEmitStepIndex: 3 }
    const state = stateOf(oneRead, emitted)
    expect(decide(state, testConfig(), view(undefined, { stepIndex: 4 })))
      .toEqual({ text: null, reason: null })
    expect(decide(state, testConfig(), view(undefined, { stepIndex: 6 })).reason).toBe('split')
    expect(decide(state, testConfig(), view(undefined, { turn: 2, stepIndex: 1 })).reason).toBe('split')
  })

  it('allows zero cooldown and a null emission step', () => {
    const state = stateOf(oneRead, { emissions: 1, lastEmitText: 'x', lastEmitTurn: 1, lastEmitStepIndex: 3 })
    expect(decide(state, testConfig({ cooldownSteps: 0 }), view()).reason).toBe('split')
    expect(decide(stateOf(oneRead, { lastEmitTurn: 1, lastEmitStepIndex: null }), testConfig(), view()).reason)
      .toBe('split')
  })

  it('reports the mechanism in observe-only mode without contributing text', () => {
    expect(decide(stateOf(oneRead), testConfig({ observeOnly: true }), view()))
      .toEqual({ text: null, reason: 'split' })
    expect(decide(stateOf(sixReads), testConfig({ observeOnly: true, windowSteps: 6, repeatedToolCalls: 4 }),
      view(undefined, { runCodeVisible: true })))
      .toEqual({ text: null, reason: 'ptc' })
  })

  it('suppresses the PTC suggestion once the shipped loop guard has spoken', () => {
    const config = testConfig({ windowSteps: 6, repeatedToolCalls: 4 })
    const state = stateOf(sixReads, { loopGuardSpoke: true })
    // The batching reminder still fires: it answers a different question than
    // "you are looping", so only the run_code suggestion is withheld.
    expect(decide(state, config, view(undefined, { runCodeVisible: true })).reason).toBe('split')
    expect(decide(state, Object.assign({}, config, { enableSplit: false }),
      view(undefined, { runCodeVisible: true })).reason).toBe(null)
    // Without the guard the same state reaches the PTC suggestion.
    expect(decide(stateOf(sixReads), config, view(undefined, { runCodeVisible: true })).reason).toBe('ptc')
  })

  it('is pure: it mutates neither the state, the config nor the view', () => {
    const freeze = <T extends object>(value: T): T => {
      for (const nested of Object.values(value)) {
        if (nested !== null && typeof nested === 'object') freeze(nested as object)
      }
      return Object.freeze(value)
    }
    const state = freeze(stateOf(sixReads))
    const config = freeze(testConfig({ windowSteps: 6, repeatedToolCalls: 4, enableSplit: false }))
    const frozen = freeze(view({ read: 'parallel' }, { runCodeVisible: true }))
    expect(decide(state, config, frozen).reason).toBe('ptc')
  })
})
