import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveBudget, type BudgetSpec } from '../src/budget.ts'
import { createStore, type LedgerStore } from '../src/store.ts'
import { createLedgerTools, type LedgerToolDependencies } from '../src/tools.ts'
import type { AdaptiveState, LedgerToolContext } from '../src/types.ts'

const NOW = 1_700_000_000_000
const PROJECT = '/work/demo'

/**
 * The tools are tested against a context supplied directly, so every call shares
 * one execution object: the wiring that resolves a context from a real call
 * belongs to the plugin spec, not here.
 */
let context: LedgerToolContext
const exec = {} as ToolRunContext
const tools = createLedgerTools({
  contextFor: () => context,
  now: () => NOW,
} satisfies LedgerToolDependencies)

let home = ''

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'context-ledger-tools-'))
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

/**
 * Find one registered tool, failing the test when it is absent.
 *
 * @param name - The tool name.
 * @returns The definition.
 */
function tool(name: string) {
  const found = tools.find(candidate => candidate.name === name)
  if (found === undefined) throw new Error(`tool ${name} is not registered`)
  return found
}

/**
 * Run one tool and type its canonical value.
 *
 * `defineTool` returns a non-generic `ToolDefinition`, whose `execute` answers
 * `unknown`; the schema each tool declares is what gives the value its type, so
 * the caller names it here.
 *
 * @param name - The tool name.
 * @param args - The arguments to pass.
 * @returns The canonical value.
 */
async function run<T>(name: string, args: unknown): Promise<T> {
  return await tool(name).execute(args, exec) as T
}

/**
 * Render one tool's value the way the registry does.
 *
 * `render` is declared over `JsonValue`, which a named result interface does not
 * satisfy without an index signature, so the value is asserted here from
 * `unknown` — the direction that widens nothing.
 *
 * @param name - The tool name.
 * @param value - The canonical value to render.
 * @returns The joined text of every text block.
 */
function rendered(name: string, value: unknown): string {
  return tool(name).output.render({}, value as JsonValue)
    .map(block => block.type === 'text' ? block.text : '')
    .join('')
}

/** A stored entry as `ledger_read` returns it. */
interface ReadValue {
  readonly id: string
  readonly kind: string
  readonly tier: string
  readonly title: string
  readonly body: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** What `ledger_status` returns. */
interface StatusValue {
  readonly projectRoot: string
  readonly profile: string
  readonly adaptive: AdaptiveState
  readonly ceilings: Record<string, number>
  readonly total: number
  readonly byKind: Record<string, number>
  readonly byTier: Record<string, number>
  readonly injected: number
  readonly retrievableOnly: number
  readonly skippedFiles: number
  readonly blockBytes: number
  readonly usage: {
    readonly usedTokens?: number
    readonly contextWindow?: number
    readonly remainingTokens?: number
    readonly basis: string
  }
}

/**
 * Build a context over a fresh store.
 *
 * @param overrides - Context fields to replace.
 * @returns The context.
 */
async function useContext(overrides: {
  budget?: BudgetSpec
  store?: LedgerStore
  adaptive?: AdaptiveState
  cached?: LedgerToolContext['cached']
  session?: LedgerToolContext['session']
  tokenMeter?: LedgerToolContext['tokenMeter']
  llm?: LedgerToolContext['llm']
  approval?: LedgerToolContext['approval']
} = {}): Promise<LedgerToolContext> {
  const scoped = await mkdtemp(join(home, 'case-'))
  const budget = overrides.budget ?? resolveBudget({})
  const session = overrides.session ?? ({ requestHeader: () => undefined } as LedgerToolContext['session'])
  context = {
    agent: {} as LedgerToolContext['agent'],
    store: overrides.store ?? createStore({ home: scoped, projectRoot: PROJECT }),
    budget,
    adaptive: overrides.adaptive ?? {
      configured: budget.profile,
      rung: budget.profile,
      ratio: 0.05,
      basis: 'static profile',
    },
    projectRoot: PROJECT,
    cached: overrides.cached ?? { text: '<project_context>\n</project_context>', root: PROJECT, entries: [] },
    session,
    tokenMeter: overrides.tokenMeter ?? undefined,
    llm: overrides.llm ?? undefined,
    approval: overrides.approval ?? undefined,
  }
  return context
}

describe('the registered tool set', () => {
  it('declares the schema the loader requires', () => {
    for (const definition of tools) {
      expect(typeof definition.name, definition.name).toBe('string')
      expect(definition.description.length, definition.name).toBeGreaterThan(0)
      expect(definition.parameters.type, definition.name).toBe('object')
      expect(typeof definition.output.render, definition.name).toBe('function')
      expect(definition.output.schema.type, definition.name).toBe('object')
      expect(typeof definition.execute, definition.name).toBe('function')
    }
  })

  it('uses the documented names', () => {
    expect(tools.map(definition => definition.name).sort()).toEqual([
      'ledger_handoff', 'ledger_history', 'ledger_promote', 'ledger_read',
      'ledger_search', 'ledger_status', 'ledger_write',
    ])
  })
})

describe('ledger_write', () => {
  it('records a fact unconfirmed and says so', async () => {
    const ctx = await useContext()
    const value = await run<{ id: string; kind: string; tier: string; updated: boolean; note: string }>(
      'ledger_write', { kind: 'build', title: 'Run tests', body: 'pnpm test' },
    )
    expect(value.tier).toBe('auto')
    expect(value.updated).toBe(false)
    expect(value.note).toMatch(/not injected/u)
    const stored = await ctx.store.get(value.id)
    expect(stored.ok ? stored.entry.body : undefined).toBe('pnpm test')
  })

  it('updates in place on a rewrite and preserves a confirmed status', async () => {
    const ctx = await useContext()
    const first = await run<{ id: string }>('ledger_write', { kind: 'build', title: 'Run tests', body: 'pnpm test' })
    const stored = await ctx.store.get(first.id)
    if (!stored.ok) throw new Error(stored.reason)
    await ctx.store.put({ ...stored.entry, tier: 'confirmed' })

    const second = await run<{ id: string; updated: boolean; tier: string; note: string }>(
      'ledger_write', { kind: 'build', title: 'run  TESTS', body: 'pnpm run test' },
    )

    expect(second.id).toBe(first.id)
    expect(second.updated).toBe(true)
    expect(second.tier).toBe('confirmed')
    expect(second.note).toMatch(/preserved/u)
    expect((await ctx.store.list()).entries).toHaveLength(1)
  })

  it('rejects an unknown kind, an empty title, and an oversized body', async () => {
    await useContext({ budget: resolveBudget({ overrides: { maxEntryBytes: 8 } }) })
    // The kind is refused by the declared enum, before the body ever runs: the
    // argument schema is the boundary, and `createEntry`'s own check is not.
    await expect(tool('ledger_write').execute({ kind: 'gossip', title: 't', body: 'b' }, exec))
      .rejects.toThrow(/invalid arguments: "kind" must be one of/u)
    await expect(tool('ledger_write').execute({ kind: 'note', title: '  ', body: 'b' }, exec))
      .rejects.toThrow(/non-empty title/u)
    await expect(tool('ledger_write').execute({ kind: 'note', title: 't', body: 'x'.repeat(9) }, exec))
      .rejects.toThrow(/over the 8-byte limit/u)
  })

  it('rejects a non-string field rather than coercing it', async () => {
    await useContext()
    await expect(tool('ledger_write').execute({ kind: 'note', title: 5, body: 'b' }, exec))
      .rejects.toThrow(/invalid arguments: "title" must be/u)
  })
})

describe('ledger_read', () => {
  it('returns the stored entry and reports an unknown id', async () => {
    await useContext()
    const written = await run<{ id: string }>('ledger_write', { kind: 'note', title: 'A fact', body: 'body text' })
    const read = await run<ReadValue>('ledger_read', { id: written.id })
    expect(read.body).toBe('body text')
    await expect(tool('ledger_read').execute({ id: 'missing' }, exec)).rejects.toThrow(/no entry/u)
    await expect(tool('ledger_read').execute({ id: '../escape' }, exec)).rejects.toThrow(/invalid entry id/u)
  })
})

describe('ledger_search', () => {
  it('reports matches, the true total, and truncation', async () => {
    await useContext({ budget: resolveBudget({ overrides: { maxSearchResults: 1 } }) })
    await run('ledger_write', { kind: 'note', title: 'Alpha one', body: 'x' })
    await run('ledger_write', { kind: 'note', title: 'Alpha two', body: 'x' })

    const result = await run<{ matches: unknown[]; total: number; truncated: boolean }>('ledger_search', { query: 'alpha' })

    expect(result.matches).toHaveLength(1)
    expect(result.total).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('says so without failing when nothing matches', async () => {
    await useContext()
    const result = await run<{ matches: unknown[]; truncated: boolean }>('ledger_search', { query: 'nothing' })
    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('rejects a limit that is not a positive integer', async () => {
    await useContext()
    await expect(tool('ledger_search').execute({ query: 'a', limit: 0 }, exec)).rejects.toThrow(/positive integer/u)
  })
})

describe('ledger_promote', () => {
  it('fails closed when no approval surface is composed', async () => {
    await useContext()
    const written = await run<{ id: string }>('ledger_write', { kind: 'note', title: 'A fact', body: 'b' })
    const value = await run<{ promoted: boolean; outcome: string; tier: string }>('ledger_promote', { id: written.id })
    expect(value.promoted).toBe(false)
    expect(value.outcome).toBe('unavailable')
    expect(value.tier).toBe('auto')
  })

  it('records the tier only when the approval allows it', async () => {
    const cases: Array<[string, boolean]> = [['allowed-once', true], ['rejected', false], ['cancelled', false]]
    for (const [outcome, expected] of cases) {
      const asked: Array<{ toolName: string; reason: string }> = []
      await useContext({
        approval: {
          async request(request: { toolName: string; reason: string }) {
            asked.push(request)
            return outcome
          },
        },
      })
      const written = await run<{ id: string }>('ledger_write', { kind: 'note', title: 'A fact', body: 'b' })
      const value = await run<{ promoted: boolean; tier: string }>('ledger_promote', { id: written.id, tier: 'curated' })

      expect(value.promoted, outcome).toBe(expected)
      expect(value.tier, outcome).toBe(expected ? 'curated' : 'auto')
      expect(asked).toHaveLength(1)
      expect(asked.map(request => request.toolName)).toEqual(['ledger_promote'])
      expect(asked.map(request => request.reason).join()).toMatch(/A fact/u)
    }
  })

  it('refuses an unknown tier and an unknown entry', async () => {
    await useContext({ approval: { async request() { return 'allowed-once' } } })
    await expect(tool('ledger_promote').execute({ id: 'x', tier: 'auto' }, exec))
      .rejects.toThrow(/invalid arguments: "tier" must be one of/u)
    await expect(tool('ledger_promote').execute({ id: 'missing' }, exec)).rejects.toThrow(/no entry/u)
  })
})

describe('ledger_status', () => {
  it('reports the budget, the census, and what is only retrievable', async () => {
    const ctx = await useContext({
      budget: resolveBudget({ profile: 'frugal' }),
      session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'demo-model' } }) } as LedgerToolContext['session'],
      tokenMeter: { measure: () => ({ totalTokens: 1234 }) },
      llm: {
        async resolveModelInfo() {
          return { context: { contextWindow: 10000 } }
        },
      },
    })

    const kept = await run<{ id: string }>('ledger_write', { kind: 'build', title: 'Kept', body: 'b' })
    await run('ledger_write', { kind: 'note', title: 'Loose', body: 'b' })
    const stored = await ctx.store.get(kept.id)
    if (!stored.ok) throw new Error(stored.reason)
    await ctx.store.put({ ...stored.entry, tier: 'confirmed' })

    const status = await run<StatusValue>('ledger_status', {})

    expect(status.projectRoot).toBe(PROJECT)
    expect(status.profile).toBe('frugal')
    expect(status.ceilings.maxIndexEntries).toBe(resolveBudget({ profile: 'frugal' }).maxIndexEntries)
    expect(status.total).toBe(2)
    expect(status.byKind).toEqual({ build: 1, note: 1 })
    expect(status.byTier).toEqual({ confirmed: 1, auto: 1 })
    expect(status.injected).toBe(1)
    expect(status.retrievableOnly).toBe(1)
    expect(status.skippedFiles).toBe(0)
    expect(status.blockBytes).toBeGreaterThan(0)
    expect(status.usage.usedTokens).toBe(1234)
    expect(status.usage.contextWindow).toBe(10000)
    expect(status.usage.remainingTokens).toBe(8766)
  })

  it('reports usage without a window or a meter rather than failing', async () => {
    await useContext()
    const status = await run<StatusValue>('ledger_status', {})
    expect(status.usage.usedTokens).toBeUndefined()
    expect(status.usage.contextWindow).toBeUndefined()
    expect(status.usage.basis).toMatch(/no routed model|token meter only/u)
  })

  it('survives a route that cannot resolve its model info', async () => {
    await useContext({
      session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'demo-model' } }) } as LedgerToolContext['session'],
      llm: {
        async resolveModelInfo(): Promise<never> {
          throw new Error('route unavailable')
        },
      },
    })
    const status = await run<StatusValue>('ledger_status', {})
    expect(status.usage.contextWindow).toBeUndefined()
    expect(status.usage.basis).toMatch(/route unavailable/u)
  })

  it('reports the rung in force and the measurement that chose it', async () => {
    await useContext({
      adaptive: {
        configured: 'adaptive',
        rung: 'identity-only',
        ratio: 0.05,
        usedTokens: 199_000,
        contextWindow: 200_000,
        basis: 'deepseek/demo-model',
      },
    })
    const status = await run<StatusValue>('ledger_status', {})

    expect(status.adaptive).toEqual({
      configured: 'adaptive',
      rung: 'identity-only',
      ratio: 0.05,
      usedTokens: 199_000,
      contextWindow: 200_000,
      basis: 'deepseek/demo-model',
    })
    const text = rendered('ledger_status', status)
    expect(text).toMatch(/rung identity-only, configured adaptive from 199000 of 200000 tokens used/u)
    // A block that shrank is otherwise indistinguishable from a broken one.
    expect(text).toMatch(/no room for memory headlines/u)
  })

  it('explains a static profile without claiming a measurement', async () => {
    await useContext()
    const status = await run<StatusValue>('ledger_status', {})
    const text = rendered('ledger_status', status)
    expect(text).toMatch(/rung balanced, configured balanced \(static profile\)/u)
    expect(text).not.toMatch(/no room for memory headlines/u)
  })

  it('reports a session whose rung has not been measured yet', async () => {
    await useContext({
      adaptive: { configured: 'adaptive', rung: 'balanced', ratio: 0.05, basis: 'not measured yet' },
    })
    const status = await run<StatusValue>('ledger_status', {})
    const text = rendered('ledger_status', status)
    expect(text).toMatch(/rung balanced, configured adaptive \(not measured yet\)/u)
  })
})

/**
 * Build an archive row for one session.
 *
 * @param sessionId - The session id.
 * @param endedAt - When the session ended.
 * @returns The row.
 */
function archived(sessionId: string, endedAt: number) {
  return {
    v: 1,
    sessionId,
    startedAt: endedAt - 1_000,
    endedAt,
    elapsedMs: 1_000,
    turns: 2,
    steps: 3,
    toolCalls: 4,
    compactions: 0,
    goalChanges: 0,
    lastTurnReason: 'completed',
    pathsTouched: ['a.ts', 'b.ts'],
    pathsTouchedTotal: 2,
  }
}

/** What `ledger_history` returns. */
interface HistoryValue {
  readonly rows: Array<{ readonly sessionId: string; readonly pathsTouchedTotal: number }>
  readonly total: number
  readonly truncated: boolean
  readonly skippedFiles: number
}

describe('ledger_history', () => {
  it('is empty before any session is archived', async () => {
    await useContext()
    const value = await run<HistoryValue>('ledger_history', {})
    expect(value.rows).toEqual([])
    expect(value.total).toBe(0)
    expect(value.truncated).toBe(false)
    expect(value.skippedFiles).toBe(0)
  })

  it('lists archived sessions newest first and reports truncation', async () => {
    const ctx = await useContext({ budget: resolveBudget({ overrides: { maxArchiveRows: 1 } }) })
    await ctx.store.putArchiveRow(archived('session-old', 1_000))
    await ctx.store.putArchiveRow(archived('session-new', 2_000))

    const value = await run<HistoryValue>('ledger_history', {})

    expect(value.rows.map(row => row.sessionId)).toEqual(['session-new'])
    expect(value.total).toBe(2)
    expect(value.truncated).toBe(true)
    expect(value.rows.map(row => row.pathsTouchedTotal)).toEqual([2])
  })

  it('caps a requested limit at the profile ceiling', async () => {
    const ctx = await useContext({ budget: resolveBudget({ overrides: { maxArchiveRows: 1 } }) })
    await ctx.store.putArchiveRow(archived('session-old', 1_000))
    await ctx.store.putArchiveRow(archived('session-new', 2_000))
    const value = await run<HistoryValue>('ledger_history', { limit: 99 })
    expect(value.rows).toHaveLength(1)
  })
})

/** What `ledger_handoff` returns. */
interface HandoffValue {
  readonly brief: string
  readonly sessions: number
  readonly facts: number
  readonly complete: boolean
  readonly note: string
}

describe('ledger_handoff', () => {
  it('works before anything is archived, covering the facts only', async () => {
    await useContext()
    const value = await run<HandoffValue>('ledger_handoff', {})
    expect(value.complete).toBe(true)
    expect(value.sessions).toBe(0)
    expect(value.note).toMatch(/No session of this project has been archived/u)
    expect(value.brief).toMatch(/Handoff brief/u)
  })

  it('carries the archived sessions and the injected facts', async () => {
    const ctx = await useContext()
    const kept = await run<{ id: string }>('ledger_write', { kind: 'build', title: 'Run the suite', body: 'pnpm test' })
    const stored = await ctx.store.get(kept.id)
    if (!stored.ok) throw new Error(stored.reason)
    await ctx.store.put({ ...stored.entry, tier: 'confirmed' })
    // The context is rebuilt rather than mutated: the seam is readonly by design.
    context = { ...context, cached: { ...context.cached, entries: (await ctx.store.list()).entries } }
    await ctx.store.putArchiveRow(archived('session-new', 2_000))

    const value = await run<HandoffValue>('ledger_handoff', {})

    expect(value.complete).toBe(true)
    expect(value.sessions).toBe(1)
    expect(value.facts).toBe(1)
    expect(value.brief).toMatch(/session-new/u)
    expect(value.brief).toMatch(/- \[build\] Run the suite/u)
    expect(value.brief).toMatch(/Start a new session in this project/u)
  })

  it('honours a requested session count', async () => {
    const ctx = await useContext()
    await ctx.store.putArchiveRow(archived('session-old', 1_000))
    await ctx.store.putArchiveRow(archived('session-new', 2_000))
    const value = await run<HandoffValue>('ledger_handoff', { sessions: 1 })
    expect(value.sessions).toBe(1)
    expect(value.brief).toMatch(/session-new/u)
    expect(value.brief).not.toMatch(/session-old/u)
  })

  it('reports when even a bare brief cannot fit', async () => {
    await useContext({ budget: resolveBudget({ overrides: { maxBriefBytes: 8 } }) })
    const value = await run<HandoffValue>('ledger_handoff', {})
    expect(value.complete).toBe(false)
    expect(value.brief).toBe('')
    expect(value.note).toMatch(/exceeded the ceiling/u)
  })
})

describe('rendering', () => {
  it('renders text for every tool value', async () => {
    await useContext()
    const written = await run<{ id: string }>('ledger_write', { kind: 'note', title: 'Rendered', body: 'b' })
    const cases: Array<[string, unknown, unknown]> = [
      ['ledger_write', { kind: 'note', title: 'Rendered', body: 'b' }, written],
      ['ledger_read', { id: written.id }, await run('ledger_read', { id: written.id })],
      ['ledger_search', { query: 'rendered' }, await run('ledger_search', { query: 'rendered' })],
      ['ledger_promote', { id: written.id }, await run('ledger_promote', { id: written.id })],
      ['ledger_status', {}, await run('ledger_status', {})],
      ['ledger_history', {}, await run('ledger_history', {})],
      ['ledger_handoff', {}, await run('ledger_handoff', {})],
    ]
    for (const [name, args, value] of cases) {
      const blocks = tool(name).output.render(args, value as JsonValue)
      expect(blocks, name).toHaveLength(1)
      expect(blocks.map(block => block.type), name).toEqual(['text'])
      expect(blocks.every(block => block.type === 'text' && block.text.length > 0), name).toBe(true)
    }
  })
})

describe('history rendering', () => {
  it('renders archived rows and reports truncation', async () => {
    const ctx = await useContext({ budget: resolveBudget({ overrides: { maxArchiveRows: 1 } }) })
    await ctx.store.putArchiveRow({ ...archived('session-old', 1_000), compactions: 2 })
    await ctx.store.putArchiveRow({ ...archived('session-new', 2_000), lastTurnReason: undefined })
    const value = await run<HistoryValue>('ledger_history', {})

    const text = rendered('ledger_history', value)

    expect(text).toContain('session-new')
    expect(text).toContain('2 turns')
    expect(text).toContain('4 tool calls')
    expect(text).toContain('2 paths')
    expect(text).toMatch(/Showing 1 of 2 archived sessions\./)
  })

  it('renders the compaction and last-turn clauses when a row carries them', async () => {
    const ctx = await useContext()
    await ctx.store.putArchiveRow({ ...archived('session-a', 1_000), compactions: 3 })
    const value = await run<HistoryValue>('ledger_history', {})
    const text = rendered('ledger_history', value)
    expect(text).toContain('3 compactions')
    expect(text).toContain('last turn completed')
  })
})

describe('usage reporting edges', () => {
  it('reports a routed model that declares no context window', async () => {
    await useContext({
      session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'demo-model' } }) } as LedgerToolContext['session'],
      llm: { async resolveModelInfo() { return {} } },
    })
    const status = await run<StatusValue>('ledger_status', {})
    expect(status.usage.contextWindow).toBeUndefined()
    expect(status.usage.basis).toBe('the routed model does not declare a context window')
  })
})

describe('render edges', () => {
  it('says Updated when a write replaced an entry', async () => {
    await useContext()
    const first = await run<{ id: string }>('ledger_write', { kind: 'note', title: 'Same', body: 'a' })
    const second = await run<{ id: string; updated: boolean }>('ledger_write', { kind: 'note', title: 'Same', body: 'b' })
    expect(second.updated).toBe(true)
    expect(rendered('ledger_write', second)).toContain(`Updated note entry ${first.id}`)
  })

  it('says so when a search matches nothing', async () => {
    await useContext()
    const value = await run('ledger_search', { query: 'nothing' })
    expect(rendered('ledger_search', value)).toBe('No recorded fact matches that.')
  })

  it('reports how many matches were shown when a search truncated', async () => {
    await useContext({ budget: resolveBudget({ overrides: { maxSearchResults: 1 } }) })
    await run('ledger_write', { kind: 'note', title: 'Alpha one', body: 'x' })
    await run('ledger_write', { kind: 'note', title: 'Alpha two', body: 'x' })
    const value = await run<{ truncated: boolean }>('ledger_search', { query: 'alpha' })
    expect(value.truncated).toBe(true)
    expect(rendered('ledger_search', value)).toMatch(/Showing 1 of 2 matches\./)
  })

  it('confirms a promoted fact in words', async () => {
    await useContext({ approval: { async request() { return 'allowed-once' } } })
    const written = await run<{ id: string }>('ledger_write', { kind: 'note', title: 'A fact', body: 'b' })
    const value = await run<{ promoted: boolean }>('ledger_promote', { id: written.id })
    expect(value.promoted).toBe(true)
    expect(rendered('ledger_promote', value)).toContain('It is now injected into new sessions')
  })

  it('explains an approval surface that answered unavailable', async () => {
    await useContext({ approval: { async request() { return 'unavailable' } } })
    const written = await run<{ id: string }>('ledger_write', { kind: 'note', title: 'A fact', body: 'b' })
    const value = await run<{ outcome: string; note: string }>('ledger_promote', { id: written.id })
    expect(value.outcome).toBe('unavailable')
    expect(rendered('ledger_promote', value)).toContain('No approval surface answered')
  })

  it('reports usage as unknown when nothing measured the session', async () => {
    await useContext()
    const value = await run<StatusValue>('ledger_status', {})
    expect(value.usage.usedTokens).toBeUndefined()
    expect(rendered('ledger_status', value)).toContain('session usage: unknown tokens used')
  })

  it('reports unreadable files in the block line', async () => {
    const ctx = await useContext()
    await ctx.store.putArchiveRow(archived('session-a', 1))
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(ctx.store.memoryDir, { recursive: true })
    await mkdir(`${ctx.store.memoryDir}/broken.md`, { recursive: true })
    void writeFile
    const value = await run<StatusValue>('ledger_status', {})
    expect(value.skippedFiles).toBe(1)
    expect(rendered('ledger_status', value)).toContain('1 unreadable files')
  })

  it('omits the path count when an archived row touched nothing', async () => {
    const ctx = await useContext()
    await ctx.store.putArchiveRow({ ...archived('session-a', 1), pathsTouched: [], pathsTouchedTotal: 0 })
    const value = await run<HistoryValue>('ledger_history', {})
    const text = rendered('ledger_history', value)
    expect(text).toContain('session-a')
    expect(text).not.toContain('paths')
  })

  it('says a brief could not be assembled when it is incomplete', async () => {
    await useContext({ budget: resolveBudget({ overrides: { maxBriefBytes: 8 } }) })
    const value = await run<HandoffValue>('ledger_handoff', {})
    expect(rendered('ledger_handoff', value)).toMatch(/Could not assemble a brief/)
  })
})

describe('status rendering without a window', () => {
  it('reports a measured token count without a window figure', async () => {
    await useContext({
      session: { requestHeader: () => undefined } as LedgerToolContext['session'],
      tokenMeter: { measure: () => ({ totalTokens: 7 }) },
    })
    const value = await run<StatusValue>('ledger_status', {})
    expect(value.usage.usedTokens).toBe(7)
    expect(value.usage.contextWindow).toBeUndefined()
    expect(rendered('ledger_status', value)).toContain('session usage: 7 tokens used')
  })
})
