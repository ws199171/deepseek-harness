/**
 * Browser half of the Execution viewer: one Conversation View target whose
 * ledger is folded from the Session's own event window. The plugin owns no
 * Host service, no Remote, and no configuration — it contributes a target, its
 * folds, its builder, and one `conversation.view` entry.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the Conversation service, its registries, and the view slot row.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard seats and ctx.uiSession.provide.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { ExecutionView } from './components/ExecutionView.tsx'
import { StepDetailPanel } from './components/StepDetailPanel.tsx'
import { EMPTY_EXECUTION_SNAPSHOT, type ExecutionSnapshot } from './contract/execution.ts'
import { registerExecutionStepDefinition } from './definitions/step-definition.ts'
import { registerExecutionThinkingDefinition } from './definitions/thinking-definition.ts'
import { en, NS, zh } from './locales.ts'
import { registerExecutionConversationView } from './view/view-definition.ts'

/** Required services: the view slot, the Session standard seats, the Conversation registries, and copy. */
export const inject = ['slots', 'uiSession', 'uiConversation', 'locale']

/**
 * Client plugin body: register the Execution target, its folds, and its tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-execution-viewer: dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without re-registering.
  const t = ctx.locale.bind(NS)
  const sources = new WeakMap<SessionBinding, ObservableSnapshot<ExecutionSnapshot>>()
  const executionSource = (binding: SessionBinding): ObservableSnapshot<ExecutionSnapshot> => {
    let source = sources.get(binding)
    if (source === undefined) {
      const target = ctx.uiConversation.binding(binding).target('execution')
      source = {
        getSnapshot: () => target.getSnapshot() ?? EMPTY_EXECUTION_SNAPSHOT,
        subscribe: listener => target.subscribe(listener),
      }
      sources.set(binding, source)
    }
    return source
  }

  registerExecutionStepDefinition(ctx.uiConversation.events)
  registerExecutionThinkingDefinition(ctx.uiConversation.events)
  registerExecutionConversationView(ctx.uiConversation.views)
  ctx.uiSession.provide({
    hooks: ['execution'],
    resolve: binding => ({ hooks: { execution: executionSource(binding) } }),
  })

  ctx.slots.inject('conversation.execution.detail', () => ctx.slots.register({
    name: 'conversation.execution.detail',
    locale: NS,
  }, StepDetailPanel))

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'execution',
    order: 20,
    locale: NS,
    label: () => t('view.execution'),
    children: {
      'conversation.execution.detail': { kind: 'single', scope: 'session' },
    },
  }, ExecutionView))
}
