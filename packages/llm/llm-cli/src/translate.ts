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

/**
 * Flatten the harness conversation into one prompt text for a stateless call.
 *
 * Only human-visible conversation crosses: user text and prior assistant
 * answers, each prefixed with its role. System-role messages are excluded
 * because {@link systemTextOf} owns the system prompt, and developer and
 * tool-role content is excluded because the delegated CLI owns its tool loop —
 * forwarding it would present harness tool scaffolding to a second agent as if
 * it were conversation.
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
  const parts: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    for (const text of textBlocksOf(message)) {
      if (text.trim().length === 0) continue
      parts.push(message.role === 'assistant' ? `Assistant: ${text}` : `User: ${text}`)
    }
  }
  if (parts.length === 0) return undefined
  return parts.join('\n\n')
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
