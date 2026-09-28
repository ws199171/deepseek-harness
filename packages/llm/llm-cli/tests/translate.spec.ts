import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { flattenConversation, systemTextOf, textBlocksOf, trailingUserText } from '../src/translate.ts'

declare module '@deepseek-ai/dsh-llm' {
  /** A harness-owned user-role context block, as a plugin producer declares one. */
  interface MessageSourceMap {
    context: { kind: 'context' }
  }
}

/** A human-authored user message. */
function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** A plugin-injected user-role context message, which must never replace human text. */
function injected(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'context' } })
}

/** A prior assistant answer. */
function assistant(text: string) {
  return createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'p', model: 'm' } })
}

describe('textBlocksOf', () => {
  it('collects text blocks and skips every other block type', () => {
    const message = createUserMessage({
      content: [
        { type: 'text', text: 'first' },
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'second' },
      ],
      source: { kind: 'user' },
    })
    expect(textBlocksOf(message)).toEqual(['first', 'second'])
  })
})

describe('systemTextOf', () => {
  it('prefers the request\'s explicit system slot', () => {
    expect(systemTextOf([createSystemMessage('from history')], 'from options')).toBe('from options')
  })

  it('reads the leading system message a loop-built request carries', () => {
    expect(systemTextOf([createSystemMessage('from history'), user('hi')])).toBe('from history')
  })

  it('skips an empty system message and any other role before it', () => {
    expect(systemTextOf([user('hi'), createSystemMessage(''), createSystemMessage('later')])).toBe('later')
  })

  it('returns undefined when the request carries no prompt', () => {
    expect(systemTextOf([user('hi')])).toBeUndefined()
  })
})

describe('flattenConversation', () => {
  it('interleaves user and assistant text with role prefixes', () => {
    expect(flattenConversation([user('question'), assistant('answer')]))
      .toBe('User: question\n\nAssistant: answer')
  })

  it('skips empty text blocks, the system prompt, and every non-conversation role', () => {
    // Injected user-role context is model-visible conversation, so a stateless
    // call forwards it; only the system prompt moves to its own slot.
    expect(flattenConversation([createSystemMessage('prompt'), user('  '), injected('ctx'), user('real')]))
      .toBe('User: ctx\n\nUser: real')
  })

  it('returns undefined when nothing text-worthy exists', () => {
    expect(flattenConversation([])).toBeUndefined()
    expect(flattenConversation([user('  ')])).toBeUndefined()
  })
})

describe('trailingUserText', () => {
  it('returns the last human user text', () => {
    expect(trailingUserText([user('first'), assistant('a'), user('second')])).toBe('second')
  })

  it('skips trailing assistant messages', () => {
    expect(trailingUserText([user('first'), assistant('a')])).toBe('first')
  })

  it('skips plugin context injected after the human input', () => {
    expect(trailingUserText([user('request'), injected('runtime context')])).toBe('request')
  })

  it('skips a candidate whose text is entirely blank', () => {
    expect(trailingUserText([user('request'), user('   ')])).toBe('request')
  })

  it('returns undefined without any human user text', () => {
    expect(trailingUserText([])).toBeUndefined()
    expect(trailingUserText([assistant('only')])).toBeUndefined()
  })
})
