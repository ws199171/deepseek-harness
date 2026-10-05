/** Conversation View Definition for the Execution target. */
import type {
  ConversationViewDefinition, ConversationViewRegistry,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ExecutionSnapshot, ExecutionViewNode } from '../contract/execution.ts'
import { ExecutionViewBuilder } from './builder.ts'

/**
 * The Execution target's registry contribution. It declares no
 * `toolCallFocus`, so the shell finds no inspection capability here: this view
 * addresses a step by its own row, not by a tool-call focus identity.
 */
export const executionViewDefinition: ConversationViewDefinition<
  ExecutionViewNode,
  ExecutionSnapshot
> = {
  target: 'execution',
  create: () => new ExecutionViewBuilder(),
  /** A Session without steps is not visible activity in this target. */
  isActive: snapshot => snapshot.stepCount > 0,
}

/**
 * Register the Execution target builder.
 * @param views - the Conversation view registry.
 */
export function registerExecutionConversationView(views: ConversationViewRegistry): void {
  views.register(executionViewDefinition)
}
