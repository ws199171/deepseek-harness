/**
 * Message translation for the CLI adapter: converts harness conversation
 * content into the prompt text one CLI child run consumes. The CLI runs its
 * own agentic loop with its own tools, so the harness tool vocabulary is not
 * forwarded; only user/assistant text crosses the boundary, and the CLI's own
 * session (keyed by the harness session id) owns its tool history.
 *
 * @module @deepseek-ai/dsh-llm-cli/translate
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/**
 * Flatten one message's text content into consecutive lines.
 * @param message - the harness message to flatten.
 * @returns its text blocks, in order.
 */
export function textBlocksOf(message: Message): string[] {
  const texts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') texts.push(block.text)
  }
  return texts
}

/**
 * Flatten the harness system slot and message history into one prompt text.
 * Assistant and user text is interleaved with role prefixes; reasoning and
 * tool blocks are skipped because the CLI's session owns its own tool history.
 * @param messages - ordered conversation messages.
 * @param system - optional system prompt text, placed first.
 * @returns the complete prompt, or `undefined` when nothing text-worthy exists.
 */
export function flattenConversation(messages: readonly Message[], system?: string): string | undefined {
  const parts: string[] = []
  if (system !== undefined && system.length > 0) {
    parts.push(system)
  }
  for (const message of messages) {
    const texts = textBlocksOf(message)
    for (const text of texts) {
      if (text.trim().length === 0) continue
      parts.push(message.role === 'assistant' ? `Assistant: ${text}` : `User: ${text}`)
    }
  }
  if (parts.length === 0) return undefined
  return parts.join('\n\n')
}

/**
 * Extract the trailing human-authored user text of a conversation. Used for
 * persistent sessions: the CLI already knows the conversation history under
 * the session id, so only the newest human input is forwarded. Plugin context
 * also uses the user role and must not replace that input.
 * @param messages - ordered conversation messages.
 * @returns the last user text block, or `undefined` when none exists.
 */
export function trailingUserText(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user' || message.source.kind !== 'user') continue
    const texts = textBlocksOf(message)
    if (texts.length > 0 && texts.some(text => text.trim().length > 0)) {
      return texts.join('\n')
    }
  }
  return undefined
}

/**
 * Flatten an assistant message's content for a block-end chunk. The CLI
 * adapter only ever emits one text block per stream, so the block content is
 * the raw assembled text.
 * @param text - assembled assistant text.
 * @returns the single text content block, or undefined when empty.
 */
export function assistantTextBlock(text: string): ContentBlock | undefined {
  return text.length === 0 ? undefined : { type: 'text', text }
}
