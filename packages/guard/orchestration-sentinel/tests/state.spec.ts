/** Configuration and projection-fold behavior. */
import { describe, expect, it } from 'vitest'

import { BUFFER_STEPS, Config } from '../src/config.ts'
import { STATE_SCHEMA, apply, init } from '../src/state.ts'
import { decide } from '../src/decide.ts'
import { testConfig } from './fixtures.ts'
import {
  clearedMarker, foldAll, foreignSnapshot, loopGuardNotice, snapshot, stepEnd, stepStart, toolCall,
  turnOf, turnStart, userMessage,
} from './fixtures.ts'

describe('config', () => {
  it('fills every default', () => {
    expect(Config({})).toEqual({
      enabled: true,
      observeOnly: false,
      windowSteps: 4,
      singleCallStreak: 3,
      repeatedToolCalls: 6,
      cooldownSteps: 3,
      maxEmissions: 3,
      enableSplit: true,
      enablePtcSuggestion: true,
    })
  })

  it('rejects out-of-range values at activation', () => {
    for (const bad of [
      { windowSteps: 9 }, { windowSteps: 0 },
      { singleCallStreak: 9 }, { singleCallStreak: 0 },
      { repeatedToolCalls: 1 }, { repeatedToolCalls: 33 },
      { cooldownSteps: 33 }, { maxEmissions: -1 }, { maxEmissions: 33 },
    ]) {
      expect(() => Config(bad), JSON.stringify(bad)).toThrow()
    }
  })

  it('rejects a fractional step count', () => {
    expect(() => Config({ windowSteps: 4.5 })).toThrow()
    expect(() => Config({ cooldownSteps: 1.5 })).toThrow()
  })

  it('keeps the buffer large enough for the widest allowed window', () => {
    const widest = Config({ windowSteps: 8, singleCallStreak: 8 })
    expect(BUFFER_STEPS).toBeGreaterThanOrEqual(widest.windowSteps as number)
    expect(BUFFER_STEPS).toBeGreaterThanOrEqual(widest.singleCallStreak as number)
  })
})

describe('state fold', () => {
  it('accumulates model-direct calls onto their step', () => {
    const state = foldAll([
      turnStart(1), stepStart(1, 1), toolCall(1, 1, 'read'), toolCall(1, 1, 'web_search'),
      stepEnd(1, 1), stepStart(1, 2), toolCall(1, 2, 'read'),
    ])
    expect(state.steps).toEqual([
      { turn: 1, step: 1, names: ['read', 'web_search'] },
      { turn: 1, step: 2, names: ['read'] },
    ])
    expect(state.stepIndex).toBe(2)
    expect(state.turn).toBe(1)
  })

  it('returns the same reference for events it ignores', () => {
    const before = foldAll([turnStart(1), stepStart(1, 1)])
    for (const ignored of [
      stepEnd(1, 1),
      userMessage('hello'),
      clearedMarker(),
      foreignSnapshot('other plugin context'),
    ]) {
      expect(apply(before, ignored), ignored.type).toBe(before)
    }
  })

  it('resets the buffer and the step ordinal on a new turn', () => {
    const first = foldAll([...turnOf(1, [['read'], ['read']]), snapshot('advice')])
    expect(first.steps).toHaveLength(2)
    expect(first.emissions).toBe(1)

    const second = apply(first, turnStart(2))
    expect(second.steps).toEqual([])
    expect(second.stepIndex).toBe(0)
    expect(second.turn).toBe(2)
    expect(second.emissions).toBe(1)
  })

  it('caps the per-turn step buffer', () => {
    const steps = Array.from({ length: BUFFER_STEPS + 1 }, () => ['read'])
    const state = foldAll(turnOf(1, steps))
    expect(state.steps).toHaveLength(BUFFER_STEPS)
    expect(state.steps[0]?.step).toBe(2)
    expect(state.steps.at(-1)?.step).toBe(BUFFER_STEPS + 1)
  })

  it('counts only its own changing snapshots', () => {
    const base = foldAll([turnStart(1), stepStart(1, 1)])
    const first = apply(base, snapshot('one'))
    expect(first.emissions).toBe(1)
    expect(first.lastEmitText).toBe('one')
    expect(first.lastEmitTurn).toBe(1)
    expect(first.lastEmitStepIndex).toBe(1)

    expect(apply(first, foreignSnapshot('one'))).toBe(first)
    expect(apply(first, clearedMarker())).toBe(first)
    expect(apply(first, snapshot('one'))).toBe(first)

    const changed = apply(first, snapshot('two'))
    expect(changed.emissions).toBe(2)
    expect(changed.lastEmitText).toBe('two')
  })

  it('re-emits the same text after compaction without counting it twice', () => {
    const state = foldAll([
      turnStart(1), stepStart(1, 1), toolCall(1, 1, 'read'),
      snapshot('advice'),
      snapshot('advice'),
    ])
    expect(state.emissions).toBe(1)
  })

  it('records that the shipped loop guard spoke, once per turn', () => {
    const spoke = foldAll([turnStart(1), loopGuardNotice()])
    expect(spoke.loopGuardSpoke).toBe(true)
    expect(apply(spoke, loopGuardNotice())).toBe(spoke)
    expect(apply(spoke, turnStart(2)).loopGuardSpoke).toBe(false)
  })

  it('accepts its own zero state and rejects a foreign checkpoint', () => {
    expect(STATE_SCHEMA.parse(init())).toEqual(init())
    expect(() => STATE_SCHEMA.parse({ ...init(), extra: 1 })).toThrow()
    expect(() => STATE_SCHEMA.parse({})).toThrow()
    expect(() => STATE_SCHEMA.parse({ ...init(), steps: [{ turn: 1, step: 1, names: [1] }] })).toThrow()
  })

  it('reconstructs identical state and identical decisions from a cold start', () => {
    const events = [
      turnStart(1), stepStart(1, 1), toolCall(1, 1, 'read'), snapshot('advice'),
      stepStart(1, 2), toolCall(1, 2, 'read'), stepStart(1, 3), toolCall(1, 3, 'read'),
      turnStart(2), stepStart(2, 1), toolCall(2, 1, 'read'),
    ]
    const live = foldAll(events)
    // A registry cold start folds `init` over the whole log before it serves a
    // read, which is what a resumed or forked session does.
    const restarted = events.reduce(apply, init())

    expect(restarted).toEqual(live)
    const view = {
      turn: 2, stepIndex: 1, runCodeVisible: false,
      classify: () => 'parallel' as const,
    }
    expect(decide(restarted, testConfig(), view)).toEqual(decide(live, testConfig(), view))
    // Re-folding never mutates an earlier result: the state it produced stays
    // the state it was.
    const midway = [turnStart(1), stepStart(1, 1), toolCall(1, 1, 'read')].reduce(apply, init())
    const snapshotOfMidway = structuredClone(midway)
    foldAll(events)
    expect(midway).toEqual(snapshotOfMidway)
  })
})
