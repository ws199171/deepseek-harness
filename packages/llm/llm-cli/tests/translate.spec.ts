import { describe, expect, it } from 'vitest'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { flattenConversation, trailingUserText } from '../src/translate.ts'

function user(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function plugin(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })
}

function assistant(text: string) {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'p', model: 'm' },
  })
}

describe('flattenConversation', () => {
  it('prepends the system text', () => {
    const result = flattenConversation([user('hi')], 'system text')
    expect(result).toBe('system text\n\nUser: hi')
  })

  it('interleaves user and assistant text with role prefixes', () => {
    const result = flattenConversation([user('question'), assistant('answer')])
    expect(result).toBe('User: question\n\nAssistant: answer')
  })

  it('skips empty text blocks', () => {
    const result = flattenConversation([user('  '), user('real')])
    expect(result).toBe('User: real')
  })

  it('returns undefined when nothing text-worthy exists', () => {
    expect(flattenConversation([], undefined)).toBeUndefined()
    expect(flattenConversation([user('  ')], undefined)).toBeUndefined()
  })
})

describe('trailingUserText', () => {
  it('returns the last user text', () => {
    expect(trailingUserText([user('first'), assistant('a'), user('second')])).toBe('second')
  })

  it('skips trailing assistant messages', () => {
    expect(trailingUserText([user('first'), assistant('a')])).toBe('first')
  })

  it('skips plugin context injected after the human input', () => {
    expect(trailingUserText([user('request'), plugin('runtime context')])).toBe('request')
  })

  it('returns undefined without any user text', () => {
    expect(trailingUserText([])).toBeUndefined()
    expect(trailingUserText([assistant('only')])).toBeUndefined()
  })
})
