/**
 * Message translation for the CLI adapter: turns harness conversation content
 * into the prompt text one CLI child run consumes, and lifts the system prompt
 * out of the history into the CLI's own system-prompt slot.
 *
 * The delegated CLI runs its own agentic loop with its own tools, so no harness
 * tool vocabulary crosses the boundary; only human-authored user text and prior
 * assistant answers do, and the CLI's own session (keyed by the harness session
 * id) owns its tool history.
 *
 * @module @deepseek-ai/dsh-llm-cli/translate
 */

import type { RequestMessage } from '@deepseek-ai/dsh-llm'

/**
 * Flatten one message's text content into consecutive lines.
 * @param message - the harness message to flatten.
 * @returns its text blocks, in order.
 */
export function textBlocksOf(message: RequestMessage): string[] {
  const texts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') texts.push(block.text)
  }
  return texts
}

/**
 * The rendered system prompt a request carries.
 *
 * Two request shapes reach an adapter, and they carry the prompt differently: a
 * loop-built request passes its derived history, whose leading system-role
 * message is the prompt, and leaves `GenerateOptions.system` undefined; a
 * hand-built one-shot may fill that field instead. Reading both — preferring
 * the explicit field — is what keeps the prompt from being silently dropped on
 * either path. System blocks are concatenated without a separator, matching the
 * projection `dsh-llm-deepseek` applies to the same history so both routes read
 * one session alike.
 * @param messages - ordered conversation messages.
 * @param system - the request's explicit system slot, when it has one.
 * @returns the system prompt text, or undefined when the request carries none.
 */
export function systemTextOf(messages: readonly RequestMessage[], system?: string): string | undefined {
  if (system !== undefined && system.length > 0) return system
  for (const message of messages) {
    if (message.role !== 'system') continue
    const text = textBlocksOf(message).join('')
    if (text.length > 0) return text
  }
  return undefined
}

/** One role-prefixed line of the flattened conversation, and who authored it. */
interface ConversationPart {
  /** The rendered `Role: text` line. */
  readonly text: string
  /** Whether a human wrote it, which is what a trailing input replaces. */
  readonly human: boolean
}

/**
 * Render the conversation as role-prefixed lines, in order.
 *
 * Only human-visible conversation crosses: user text and prior assistant
 * answers. System-role messages are excluded because {@link systemTextOf} owns
 * the system prompt, and developer and tool-role content is excluded because
 * the delegated CLI owns its tool loop — forwarding it would present harness
 * tool scaffolding to a second agent as if it were conversation.
 *
 * @param messages - ordered conversation messages.
 * @returns one part per text block, in conversation order.
 */
function conversationParts(messages: readonly RequestMessage[]): ConversationPart[] {
  const parts: ConversationPart[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    for (const text of textBlocksOf(message)) {
      if (text.trim().length === 0) continue
      parts.push({
        text: message.role === 'assistant' ? `Assistant: ${text}` : `User: ${text}`,
        human: message.role === 'user' && message.source?.kind === 'user',
      })
    }
  }
  return parts
}

/**
 * Flatten the harness conversation into one prompt text for a stateless call.
 *
 * Plugin-injected user-role context is user-role conversation and therefore
 * *is* forwarded here: a stateless call has no CLI-side history, so dropping it
 * would hand the CLI a different conversation than the harness model would have
 * seen. That is the opposite of {@link trailingUserText}, where the same
 * injected text must not displace the human's newest input.
 *
 * @param messages - ordered conversation messages.
 * @returns the complete prompt, or `undefined` when nothing text-worthy exists.
 */
export function flattenConversation(messages: readonly RequestMessage[]): string | undefined {
  const parts = conversationParts(messages)
  if (parts.length === 0) return undefined
  return parts.map(part => part.text).join('\n\n')
}

/**
 * The conversation as it stood before the newest human input, for a delegated
 * CLI that owns no history of it.
 *
 * The ACP transport keeps the CLI's own session alive, so an ongoing
 * conversation normally never needs this. It is the fallback for the cases
 * where that session is gone — a restarted harness, a replaced child, or a CLI
 * that refused to resume one — and the CLI would otherwise answer the newest
 * message knowing nothing that came before it.
 *
 * @param messages - ordered conversation messages.
 * @returns the prior turns, or `undefined` when only the newest input exists.
 */
export function conversationRecap(messages: readonly RequestMessage[]): string | undefined {
  const parts = conversationParts(messages)
  const newest = parts.findLastIndex(part => part.human)
  // Everything up to the newest input, in order: what follows it is this call's
  // own context, and repeating it ahead of that input would reorder the turn.
  const recap = newest === -1 ? parts : parts.slice(0, newest)
  if (recap.length === 0) return undefined
  return recap.map(part => part.text).join('\n\n')
}

/**
 * Extract the trailing human-authored user text of a conversation. A
 * persistent session forwards only the newest human input, because the CLI
 * already knows the history under the session id. Plugin context also uses the
 * user role, so the message source — not the role alone — is what distinguishes
 * the human's words from an injected context message that must not replace them.
 * @param messages - ordered conversation messages.
 * @returns the last human-authored user text, or `undefined` when none exists.
 */
export function trailingUserText(messages: readonly RequestMessage[]): string | undefined {
  let found: string | undefined
  for (const message of messages) {
    if (message.role !== 'user' || message.source?.kind !== 'user') continue
    const texts = textBlocksOf(message).filter(text => text.trim().length > 0)
    if (texts.length > 0) found = texts.join('\n')
  }
  return found
}
