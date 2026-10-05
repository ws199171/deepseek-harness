import { describe, expect, it } from 'vitest'
import { absolutePathOf, contains, isInside } from '../src/paths.ts'

const ROOT = '/work/demo'

describe('absolutePathOf', () => {
  it('resolves a relative path against the session directory', () => {
    expect(absolutePathOf('src/a.ts', ROOT)).toBe('/work/demo/src/a.ts')
    expect(absolutePathOf('/elsewhere/a.ts', ROOT)).toBe('/elsewhere/a.ts')
    expect(absolutePathOf('  src/a.ts  ', ROOT)).toBe('/work/demo/src/a.ts')
  })

  it('resolves an unplaceable path to nothing', () => {
    expect(absolutePathOf('', ROOT)).toBeUndefined()
    expect(absolutePathOf('   ', ROOT)).toBeUndefined()
    expect(absolutePathOf('src/a.ts', undefined)).toBeUndefined()
  })
})

describe('isInside and contains', () => {
  it('excludes the ancestor itself from containment, and covers it separately', () => {
    expect(isInside('/work/demo/a.ts', ROOT)).toBe(true)
    expect(isInside('/work/demo/a/b.ts', ROOT)).toBe(true)
    expect(isInside(ROOT, ROOT)).toBe(false)
    expect(isInside('/work/other/a.ts', ROOT)).toBe(false)
    // A prefix is not a descendant: "/work/demolish" must not read as inside
    // "/work/demo".
    expect(isInside('/work/demolish/a.ts', ROOT)).toBe(false)

    expect(contains(ROOT, ROOT)).toBe(true)
    expect(contains('/work', '/work/demo/a.ts')).toBe(true)
    expect(contains(ROOT, '/work/other/a.ts')).toBe(false)
  })
})
