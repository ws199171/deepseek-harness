/** Guidance-text behavior: pure, unique per window, and free of verdicts. */
import { describe, expect, it } from 'vitest'

import { ptcText, splitText } from '../src/guidance.ts'

describe('guidance text', () => {
  it('is a pure function of the observed window', () => {
    const window = { turn: 2, firstStep: 3, lastStep: 5, count: 3 }
    expect(splitText(window)).toBe(splitText({ ...window }))
    expect(splitText(window)).not.toBe(splitText({ ...window, turn: 3 }))
    expect(splitText(window)).not.toBe(splitText({ ...window, firstStep: 4, lastStep: 6 }))
    expect(splitText({ turn: 1, firstStep: 5, lastStep: 5, count: 1 }))
      .toContain('step 5)')
  })

  it('states only observed facts and a conditional suggestion', () => {
    const split = splitText({ turn: 1, firstStep: 2, lastStep: 4, count: 3 })
    expect(split).toContain('turn 1, step 2–4')
    expect(split).toContain('these 3 steps each issued exactly one tool call')
    expect(split).toContain('If the read-only work')
    expect(split).not.toMatch(/can be merged|dependency exists|must be batched/u)
    expect(split).not.toMatch(/read\(|\.ts/u)

    const ptc = ptcText({ turn: 1, firstStep: 3, lastStep: 8, tool: 'read', count: 6 })
    expect(ptc).toContain('turn 1, step 3–8')
    expect(ptc).toContain('read has been called 6 times')
    expect(ptc).toContain('run_code')
    expect(ptc).toContain('If the work left')
    expect(ptc).not.toMatch(/mode|switch to/u)
  })
})
