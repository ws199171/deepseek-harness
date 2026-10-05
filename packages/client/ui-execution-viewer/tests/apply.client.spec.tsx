// @vitest-environment jsdom
/**
 * Plugin wiring on the real framework stack: the plugin fiber registers the
 * Execution tab in the Conversation view ring, exposes its ledger through
 * `uiSession.provide`, addresses the Execution target of the bound Session,
 * and tears every contribution down with its fiber.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConversationBinding } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import * as localePlugin from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/apply.ts'
import { EMPTY_EXECUTION_SNAPSHOT, type ExecutionSnapshot } from '../src/client/contract/execution.ts'

const SID = 'session-1' as SessionId

const runtimes: SlotTestRuntime[] = []

/** Mount the plugin on a real Context with the Conversation registries and locale. */
async function bench(snapshot: ExecutionSnapshot = EMPTY_EXECUTION_SNAPSHOT) {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const ctx = runtime.ctx
  const slots = runtime.slots
  await runtime.sessions.add({
    id: SID,
    snapshot: { blank: false },
    session: { loadOlder: vi.fn(() => Promise.resolve()) },
  })
  const reference = runtime.sessions.retain(SID)
  await reference.ready

  const executionStore = createSnapshotStore<ExecutionSnapshot | undefined>(snapshot)
  const uiConversation = new UiConversation(ctx, runtime.sessions)
  const target = vi.fn((_name: string): ObservableSnapshot<ExecutionSnapshot | undefined> => executionStore)
  const binding: ConversationBinding = {
    snapshot: createSnapshotStore({ views: undefined, activeTargets: new Set<string>() } as never),
    openTurn: createSnapshotStore<number | undefined>(undefined),
    activate: () => {},
    target,
  }
  vi.spyOn(uiConversation, 'binding').mockReturnValue(binding)
  // The conversation entry's role: declare the view ring the plugin contributes to.
  await runtime.root.declare(
    { 'conversation.view': { kind: 'list', scope: 'session' } },
    (_props: { renderSlot?: unknown }) => null,
  )
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  await runtime.mount(localePlugin)
  const provide = vi.spyOn(ctx.uiSession, 'provide')
  const feature = await runtime.mount({ inject: [...inject], apply })
  const descriptor = provide.mock.calls[0]?.[0]
  if (descriptor === undefined) throw new Error('ui-execution-viewer did not provide its standard source')
  return { runtime, slots, feature, descriptor, executionStore, target, binding }
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})

describe('Execution viewer wiring', () => {
  it('adds its tab to the Conversation view ring and removes it on unload', async () => {
    const { slots, feature } = await bench()
    const ids = slots.entries('conversation.view').map(entry => entry.options.id)
    expect(ids).toContain('execution')
    const entry = slots.entries('conversation.view').find(candidate => candidate.options.id === 'execution')
    expect(resolveSlotLabel(entry?.options.label)).toBe('Execution')
    await feature.dispose()
    expect(slots.entries('conversation.view').map(candidate => candidate.options.id)).not.toContain('execution')
  })

  it('exposes the ledger through the session standard hook and reads the bound target', async () => {
    const { descriptor, executionStore, target, binding } = await bench({
      turns: [], stepCount: 2, runningCount: 0,
    })
    expect(descriptor.hooks).toEqual(['execution'])
    const resolved = descriptor.resolve(binding)
    const source = resolved.hooks?.execution
    if (source === undefined) throw new Error('the execution hook was not provided')
    expect(source.getSnapshot()).toEqual({ turns: [], stepCount: 2, runningCount: 0 })
    expect(target).toHaveBeenCalledWith('execution')
    const listener = vi.fn()
    source.subscribe(listener)
    executionStore.set({ turns: [], stepCount: 3, runningCount: 1 })
    expect(listener).toHaveBeenCalled()
    // One binding keeps one identity-stable source for the whole Session lifetime.
    expect(descriptor.resolve(binding).hooks?.execution).toBe(source)
    expect(target).toHaveBeenCalledTimes(1)
    // The source falls back to the empty ledger while a Session has no target snapshot.
    executionStore.set(undefined)
    expect(source.getSnapshot()).toEqual(EMPTY_EXECUTION_SNAPSHOT)
  })
})
