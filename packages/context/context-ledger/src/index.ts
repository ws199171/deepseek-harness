/**
 * Project context ledger — project identity, durable memory, session archive,
 * directory conventions, and adaptive budget.
 *
 * The block the model sees carries identity plus the memory headlines that earned
 * a slot. Everything else is reachable through the `ledger_*` tools, and
 * directory conventions are delivered once, on touch, through the inbox.
 *
 * The plugin appends no session events. A third-party plugin cannot set the
 * `ignorable` envelope marker an unknown stored event type requires, so durable
 * plugin state lives in the Harness home, the block is carried as an ordinary
 * runtime-context snapshot, and conventions ride a `user/message` whose source
 * kind this plugin owns — all of which the Harness logs.
 *
 * @module @deepseek-ai/dsh-context-ledger
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { ToolExecution, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { deriveArchiveRow } from './archive.ts'
import { resolveSessionBudget, type BudgetSpec } from './budget.ts'
import { Config, resolveConfig, type ResolvedConfig } from './config.ts'
import { conventionCandidates, renderConventions, type ConventionDocument } from './conventions.ts'
import { CONTEXT_NAME, presentManifests, renderIdentity } from './identity.ts'
import { absolutePathOf, isInside } from './paths.ts'
import { findProjectRoot, probeManifests, probePath } from './root.ts'
import { createStore, type LedgerStore } from './store.ts'
import { createLedgerTools } from './tools.ts'
import type { AdaptiveState, CachedBlock, LedgerToolContext } from './types.ts'
import { readUsage } from './usage.ts'

/** Plugin name used by the Cordis loader. */
export const name = 'dsh-context-ledger'

/**
 * The convention message's source kind.
 *
 * The message-source map is merge-extensible by design — each producer declares
 * its own kind in its own module — but a new kind is admitted by declaration
 * merging, not by widening the union. Consumers fall through an unknown kind at
 * runtime, so this cannot collide with a first-party kind.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A directory-convention message this plugin delivered on touch. */
    'context-ledger-conventions': { kind: 'context-ledger-conventions' }
  }
}

/**
 * Required services. The filesystem provider, session store, session query, token
 * meter, model router, and approval surface are all read through `ctx.get`, so a
 * deployment missing one loses only that capability instead of failing to load.
 */
export const inject = ['systemPrompt', 'tools']

export { Config }

/**
 * Source kind on the convention message.
 *
 * The message-source map is merge-extensible by design — each producer declares
 * its own kind and consumers fall through unknown ones — so this needs no
 * registration and cannot collide with a first-party kind.
 */
const CONVENTION_SOURCE_KIND = 'context-ledger-conventions'

/** Tool names whose success can change a project's manifest set. */
const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(['write', 'edit'])

/** Tool names whose path argument marks a directory as touched. */
const PATH_TOOL_NAMES: ReadonlySet<string> = new Set(['read', 'write', 'edit'])

/** Tool-name prefix marking a call that may have changed ledger contents. */
const LEDGER_TOOL_PREFIX = 'ledger_'

/** Read a tool execution's `file_path` argument. */
function filePathOf(exec: Readonly<ToolExecution>, toolNames: ReadonlySet<string>): string | undefined {
  if (!toolNames.has(exec.name)) return undefined
  const args = exec.arguments
  if (typeof args !== 'object' || args === null || !('file_path' in args)) return undefined
  const filePath = (args as { file_path?: unknown }).file_path
  return typeof filePath === 'string' ? filePath : undefined
}

/**
 * Register the plugin.
 *
 * @param ctx - The plugin's context.
 * @param config - Config from the profile patch, already validated against {@link Config}.
 * @returns Nothing.
 * @throws TypeError When the budget profile, an override key, or the ratio is unusable.
 * @throws RangeError When a marker list, a ceiling, or the ratio is unusable.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  if (!resolved.enabled) return

  /**
   * Rendered block per session, with the project root behind it.
   *
   * The synchronous provider reads only this map; every filesystem read happens
   * outside it, so the provider never blocks an assembly.
   */
  const rendered = new WeakMap<object, CachedBlock>()

  /**
   * The ceilings in force for a session. Under the adaptive profile this is
   * replaced only at a checkpoint, which is what keeps the block byte-stable
   * within a turn.
   */
  const sessionBudgets = new WeakMap<object, BudgetSpec>()

  /** Why a session is on the rung it is on, so `ledger_status` can explain a shrink. */
  const sessionRungs = new WeakMap<object, AdaptiveState>()

  /** Convention files already delivered per session, so each is delivered once. */
  const deliveredConventions = new WeakMap<object, Set<string>>()

  /**
   * Convention bytes delivered per session, so the session ceiling holds across
   * the whole session rather than per directory.
   */
  const conventionBytes = new WeakMap<object, number>()

  /** One store per project root, so repeated refreshes share a handle. */
  const stores = new Map<string, LedgerStore>()

  /**
   * Scoped-context disposer per agent. Unloading the plugin does not dispose
   * `agent.ctx` registrations by itself, so the plugin keeps them to remove on its
   * own teardown as well as on `agent/disposed`.
   */
  const registrations = new Map<Agent, () => unknown>()

  /** Serializes refreshes per agent so an earlier, slower read cannot overwrite a later one. */
  const refreshTails = new WeakMap<object, Promise<void>>()

  /** Serializes convention delivery per agent, for the same reason. */
  const conventionTails = new WeakMap<object, Promise<void>>()

  const lifecycle = new AbortController()
  ctx.effect(() => () => {
    lifecycle.abort(new Error('dsh-context-ledger disposed'))
    for (const dispose of registrations.values()) void dispose()
    registrations.clear()
  }, 'dsh-context-ledger.lifecycle')

  /**
   * Open, or reuse, the store for one project root.
   *
   * @param projectRoot - The project root.
   * @returns The store handle.
   */
  const storeFor = (projectRoot: string): LedgerStore => {
    const existing = stores.get(projectRoot)
    if (existing !== undefined) return existing
    const created = createStore({ home: resolved.ledgerHome, projectRoot })
    stores.set(projectRoot, created)
    return created
  }

  /**
   * The ceilings in force for one session.
   *
   * @param session - The session.
   * @returns Its current budget.
   */
  const effectiveBudget = (session: object): BudgetSpec => sessionBudgets.get(session) ?? resolved.budget

  /**
   * How a session's rung was decided.
   *
   * An adaptive deployment that shrinks its own payload is indistinguishable from
   * a broken one unless it can say why, so the measurement behind the rung is
   * reported rather than kept private.
   *
   * @param session - The session.
   * @returns The configured profile, the chosen rung, and the basis.
   */
  const adaptiveStateOf = (session: object): AdaptiveState => {
    const measured = sessionRungs.get(session)
    if (measured !== undefined) return measured
    // Unreachable: `agent/created` measures the rung before the block is
    // registered, so every session a tool can address has a stored measurement.
    /* v8 ignore next -- the rung is always measured before the block exists */
    return resolved.budgetProfile === 'adaptive'
      ? {
        configured: 'adaptive',
        rung: resolved.budget.profile,
        ratio: resolved.adaptiveUtilizationRatio,
        basis: 'not measured yet; the default rung applies until the first checkpoint',
      }
      : {
        configured: resolved.budgetProfile,
        rung: resolved.budget.profile,
        ratio: resolved.adaptiveUtilizationRatio,
        basis: 'static profile',
      }
  }

  /**
   * Resolve what a `ledger_*` tool call operates on.
   *
   * A tool reads the same cache the injected block is built from, so it can never
   * address a different project than the one the model was told about.
   *
   * @param exec - The tool run context.
   * @returns The store and the services the tools may use.
   * @throws Error When the call has no agent, or the session is outside any detected project.
   */
  const contextFor = (exec: ToolRunContext): LedgerToolContext => {
    const agent = exec.agent
    if (agent === undefined) throw new Error('the ledger needs an agent-scoped tool call')
    const cached = rendered.get(agent.session)
    if (cached === undefined) {
      throw new Error(
        'this session is not inside a detected project, so it has no ledger; a project root needs one of the configured markers',
      )
    }
    return {
      agent,
      store: storeFor(cached.root),
      budget: effectiveBudget(agent.session),
      adaptive: adaptiveStateOf(agent.session),
      projectRoot: cached.root,
      cached,
      session: agent.session,
      tokenMeter: ctx.get('tokenMeter'),
      llm: ctx.get('llm'),
      approval: ctx.get('approval'),
    }
  }

  for (const tool of createLedgerTools({ contextFor, now: () => Date.now() })) {
    ctx.tools.register(tool)
  }

  /**
   * Recompute a session's rung from its remaining window.
   *
   * Called only at checkpoints — session start, a turn boundary, and the end of a
   * compaction. Recomputing per request would make the block change on every step,
   * which costs far more in prompt-cache invalidation than the rung can save.
   *
   * @param agent - The agent to measure.
   * @returns Resolves once the session's budget is current.
   */
  const chooseRung = async (agent: Agent): Promise<void> => {
    if (resolved.budgetProfile !== 'adaptive') return
    const usage = await readUsage({
      session: agent.session,
      tokenMeter: ctx.get('tokenMeter'),
      llm: ctx.get('llm'),
      signal: lifecycle.signal,
    })
    const { rung, budget } = resolveSessionBudget({
      profile: 'adaptive',
      overrides: resolved.budgetOverrides,
      ratio: resolved.adaptiveUtilizationRatio,
      usedTokens: usage.usedTokens,
      contextWindow: usage.contextWindow,
    })
    sessionBudgets.set(agent.session, budget)
    sessionRungs.set(agent.session, {
      configured: 'adaptive',
      rung,
      ratio: resolved.adaptiveUtilizationRatio,
      basis: usage.basis,
      ...usage.usedTokens === undefined ? {} : { usedTokens: usage.usedTokens },
      ...usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow },
    })
  }

  /**
   * Recompute one agent's cached block, leaving it untouched when unchanged.
   *
   * @param agent - The agent to refresh.
   * @returns Resolves after the cache reflects current state.
   */
  const refresh = async (agent: Agent): Promise<void> => {
    const session = agent.session
    const fileSystem = ctx.get('fs')
    const cwd = session.header.cwd
    if (fileSystem === undefined || cwd === undefined) {
      rendered.delete(session)
      return
    }
    const { root, hasMarker } = await findProjectRoot({
      cwd,
      markers: resolved.projectRootMarkers,
      fileSystem,
      signal: lifecycle.signal,
    })
    if (!hasMarker) {
      rendered.delete(session)
      return
    }
    const manifests = await probeManifests({
      projectRoot: root,
      names: resolved.stackManifestNames,
      fileSystem,
      signal: lifecycle.signal,
    })
    const { entries } = await storeFor(root).list()
    const text = renderIdentity({
      projectRoot: root,
      includeProjectName: resolved.includeProjectName,
      presentManifests: presentManifests(manifests),
      entries,
      budget: effectiveBudget(session),
    })
    // Comparing the rendered text rather than a derived key means the cache can
    // never disagree with what is injected.
    if (rendered.get(session)?.text === text) return
    rendered.set(session, { text, root, entries })
  }

  /**
   * Queue work behind any in-flight work of the same kind for the same agent.
   *
   * Failures are logged and dropped. This runs from `agent/created`, where a
   * thrown error would roll back agent creation, and from tool results, where a
   * thrown error would surface as a tool failure the model did not cause.
   *
   * @param tails - The per-agent chain to extend.
   * @param agent - The agent.
   * @param work - The work to run.
   * @param label - What to name in a warning.
   * @returns Nothing.
   */
  const queue = (
    tails: WeakMap<object, Promise<void>>,
    agent: Agent,
    work: () => Promise<void>,
    label: string,
  ): void => {
    const previous = tails.get(agent) ?? Promise.resolve()
    const current = previous.then(work).catch((error: unknown) => {
      // Unreachable: a failure raised after the plugin is disposed is dropped,
      // and disposal is the only path that aborts this signal.
      /* v8 ignore next -- teardown is the only abort source */
      if (!lifecycle.signal.aborted) ctx.logger.warn(`dsh-context-ledger: ${label} failed: %o`, error)
    })
    tails.set(agent, current)
    void current.then(() => {
      if (tails.get(agent) === current) tails.delete(agent)
    })
  }

  /**
   * Deliver the conventions that apply to one touched file.
   *
   * A candidate is marked delivered before its contents are read, so a directory
   * touched repeatedly is probed once. A convention too large for the per-file
   * ceiling is delivered as a note rather than dropped: a file the model was never
   * told about is indistinguishable from one that does not exist.
   *
   * @param agent - The agent whose session was touched.
   * @param touchedPath - Absolute path of the file a tool touched.
   * @returns Resolves after delivery or a contained failure.
   */
  const deliverConventions = async (agent: Agent, touchedPath: string): Promise<void> => {
    const fileSystem = ctx.get('fs')
    const cached = rendered.get(agent.session)
    // Unreachable: `tools/result` only queues a session that already has a cached
    // block, and a block exists only when a filesystem provider resolved one — so
    // both operands are guaranteed by the caller.
    /* v8 ignore next -- the caller only queues a resolved, cached session */
    if (fileSystem === undefined || cached === undefined) return
    const budget = effectiveBudget(agent.session)
    if (budget.maxConventionSessionBytes <= 0 || budget.maxConventionFileBytes <= 0) return

    const delivered = deliveredConventions.get(agent.session) ?? new Set<string>()
    deliveredConventions.set(agent.session, delivered)
    const candidates = conventionCandidates({
      touchedPath,
      projectRoot: cached.root,
      fileNames: resolved.conventionFileNames,
    }).filter(path => !delivered.has(path))
    if (candidates.length === 0) return

    const documents: ConventionDocument[] = []
    for (const path of candidates) {
      delivered.add(path)
      const probe = await probePath(fileSystem, path, lifecycle.signal)
      if (!probe.present) continue
      if ((probe.size ?? 0) > budget.maxConventionFileBytes) {
        documents.push({
          path,
          text: `(not included: ${probe.size} bytes exceeds the ${budget.maxConventionFileBytes}-byte ceiling)`,
        })
        continue
      }
      const target = await fileSystem.resolve(path, { signal: lifecycle.signal })
      documents.push({ path, text: await fileSystem.readText(target, lifecycle.signal) })
    }
    if (documents.length === 0) return

    const spent = conventionBytes.get(agent.session) ?? 0
    const { text } = renderConventions({
      documents,
      projectRoot: cached.root,
      maxBytes: Math.max(0, budget.maxConventionSessionBytes - spent),
    })
    if (text.length === 0) return
    conventionBytes.set(agent.session, spent + Buffer.byteLength(text, 'utf8'))
    // The inbox is the sanctioned seeded-context channel and the Harness logs the
    // splice, so this stays within *model-visible ⟺ logged*.
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: CONVENTION_SOURCE_KIND },
    }))
  }

  /**
   * Derive and store one archive row for a session that has just ended.
   *
   * The log is complete once the driver has quiesced, but buffered events may not
   * be durable yet, so the session is flushed before it is read: reading first
   * would archive a row that silently misses the tail. This is best-effort by
   * construction — disposal is an emit, so nothing awaits it, and an archive
   * failure must never surface as a teardown error.
   *
   * @param agent - The agent being disposed.
   * @returns Resolves once the row is stored or the failure is logged.
   */
  const captureArchive = async (agent: Agent): Promise<void> => {
    if (!resolved.archiveEnabled) return
    const cached = rendered.get(agent.session)
    // A session whose project was never resolved has no ledger to file it under.
    if (cached === undefined) return
    const sessions = ctx.get('sessions')
    const sessionQuery = ctx.get('sessionQuery')
    if (sessions === undefined || sessionQuery === undefined) return
    try {
      await sessions.flush(agent.session)
      const snapshot = await sessionQuery.readSession(agent.session.id)
      const row = deriveArchiveRow({
        sessionId: agent.session.id,
        events: snapshot.events,
        maxPaths: effectiveBudget(agent.session).maxArchivedPaths,
      })
      if (row === undefined) return
      await storeFor(cached.root).putArchiveRow(row)
    } catch (error) {
      // Unreachable: disposal aborts the lifecycle signal, and disposal is the
      // only path that reaches this catch after teardown.
      /* v8 ignore next -- teardown is the only abort source */
      if (!lifecycle.signal.aborted) {
        ctx.logger.warn('dsh-context-ledger: could not archive a session: %o', error)
      }
    }
  }

  ctx.on('agent/created', async ({ agent }) => {
    const dispose = agent.ctx.effect(() => agent.ctx.systemPrompt.context({
      name: CONTEXT_NAME,
      order: resolved.contextOrder,
      text: (context) => {
        const session = context.agent?.session
        return session === undefined ? '' : rendered.get(session)?.text ?? ''
      },
    }), 'dsh-context-ledger.context')
    registrations.set(agent, dispose)
    // Registration happens before the first read so a failed read yields an empty
    // block rather than a missing provider.
    await chooseRung(agent)
    queue(refreshTails, agent, () => refresh(agent), 'project context refresh')
    await refreshTails.get(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    void registrations.get(agent)?.()
    registrations.delete(agent)
    void captureArchive(agent)
  })

  // `turn/start` and `compaction/end` are session event types, not Cordis events.
  // They are the checkpoints at which a project mutated outside the session becomes
  // visible and at which the adaptive rung may move.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/start' && event.type !== 'compaction/end') return
    for (const agent of registrations.keys()) {
      if (agent.session !== session) continue
      queue(refreshTails, agent, async () => {
        await chooseRung(agent)
        await refresh(agent)
      }, 'project context checkpoint')
    }
  })

  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    if (result.isError) return
    const agent = exec.agent
    if (agent === undefined || exec.signal.aborted) return
    const cached = rendered.get(agent.session)
    if (cached === undefined) return

    const touchedPath = filePathOf(exec, PATH_TOOL_NAMES)
    if (touchedPath !== undefined) {
      const absolute = absolutePathOf(touchedPath, agent.session.header.cwd)
      if (absolute !== undefined && isInside(absolute, cached.root)) {
        queue(conventionTails, agent, () => deliverConventions(agent, absolute), 'convention delivery')
      }
    }

    // A ledger call can change the memory index; a file edit can change the
    // manifest set, but only inside the project.
    const ledgerCall = exec.name.startsWith(LEDGER_TOOL_PREFIX)
    const manifestEdit = filePathOf(exec, MUTATING_TOOL_NAMES) !== undefined
    if (!ledgerCall && !manifestEdit) return
    queue(refreshTails, agent, () => refresh(agent), 'project context refresh')
  })
}
