import { describe, expect, it } from 'vitest'
import { errorMessage } from '../src/errors.ts'

describe('errorMessage', () => {
  it('reads the message of an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('stringifies a caught value that is not an Error', () => {
    expect(errorMessage('just text')).toBe('just text')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})
