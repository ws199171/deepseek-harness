/**
 * The ledger's model-facing tools.
 *
 * Tool arguments cross a model boundary, so `defineTool` compiles the declared
 * schema into JSON Schema and the registry validates against it before `execute`
 * runs. What is left here is the part the schema cannot state — that a count is
 * positive, that a body fits the budget, that a promotion was approved — and a
 * normal, model-visible failure is reported by throwing an `Error`.
 *
 * @module @deepseek-ai/dsh-context-ledger/tools
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { renderBrief } from './brief.ts'
import {
  ENTRY_KINDS,
  PROMOTABLE_TIERS,
  censusOf,
  createEntry,
  entryId,
  promoteEntry,
  rankForIndex,
} from './entry.ts'
import type { LedgerToolContext } from './types.ts'
import { readUsage } from './usage.ts'

/**
 * Render one text block, the shape `output.render` returns.
 *
 * @param value - The text.
 * @returns A single text content block.
 */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/**
 * Read an optional count argument and require it to be positive.
 *
 * The parameter schema declares `integer`, which the registry enforces, but the
 * DSL has no `minimum` keyword, so positivity is this tool's own constraint and
 * has to be checked here.
 *
 * @param value - The validated argument, when present.
 * @param field - The field name, for the error message.
 * @returns The count, or `undefined` when the caller omitted it.
 * @throws TypeError When the value is present but not positive.
 */
function positiveCount(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive integer`)
  return value
}

/** What the tool builders need from the plugin. */
export interface LedgerToolDependencies {
  /** Resolve the calling agent's store, budget, and services. */
  readonly contextFor: (exec: ToolRunContext) => LedgerToolContext
  /** Current epoch milliseconds. */
  readonly now: () => number
}

/**
 * Build the ledger's tools.
 *
 * @param request - The tool dependencies.
 * @param request.contextFor - Resolves the calling agent's store and resolved budget, throwing a
 *   model-readable error when the session is not in a project.
 * @param request.now - Current epoch milliseconds.
 * @returns Tool definitions ready for `ctx.tools.register`.
 */
export function createLedgerTools(request: LedgerToolDependencies): ToolDefinition[] {
  const { contextFor, now } = request
  return [
    defineTool({
      name: 'ledger_write',
      description: [
        'Record one durable fact about the current project, so later sessions start knowing it.',
        'Use it for build and test commands, decisions already settled, and pitfalls that cost time.',
        'Do not record what the repository already states, and do not record secrets.',
        'A new entry is unconfirmed: it is retrievable but not injected into new sessions until a human confirms it.',
        'Rewriting an entry with the same kind and title updates it in place and preserves its confirmed status.',
      ].join(' '),
      parameters: {
        kind: { type: 'string', enum: [...ENTRY_KINDS], required: true },
        title: { type: 'string', required: true, description: 'One line naming the fact, at most 200 characters.' },
        body: { type: 'string', required: true, description: 'The fact itself, in markdown.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            kind: { type: 'string', required: true },
            tier: { type: 'string', required: true },
            updated: { type: 'boolean', required: true },
            note: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(
          `${value.updated ? 'Updated' : 'Recorded'} ${value.kind} entry ${value.id} at tier ${value.tier}. ${value.note}`,
        ),
      },
      async execute(args, exec) {
        const { store, budget } = contextFor(exec)
        const bodyBytes = Buffer.byteLength(args.body, 'utf8')
        if (bodyBytes > budget.maxEntryBytes) {
          throw new RangeError(
            `body is ${bodyBytes} bytes, over the ${budget.maxEntryBytes}-byte limit of the ${budget.profile} budget profile`,
          )
        }
        const existing = await store.get(entryId(args.kind, args.title))
        const prior = existing.ok ? existing.entry : undefined
        const created = createEntry({ kind: args.kind, title: args.title, body: args.body, now: now(), existing: prior })
        // A rewrite must not silently demote a fact a human already approved.
        const entry = prior !== undefined && prior.tier !== 'auto' ? promoteEntry(created, prior.tier, now()) : created
        await store.put(entry)
        return {
          id: entry.id,
          kind: entry.kind,
          tier: entry.tier,
          updated: prior !== undefined,
          note: entry.tier === 'auto'
            ? 'It is not injected into new sessions until ledger_promote is approved.'
            : 'Its confirmed status was preserved.',
        }
      },
    }),

    defineTool({
      name: 'ledger_read',
      description: 'Read one recorded project fact in full by its id. Search first if the id is unknown.',
      parameters: {
        id: { type: 'string', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            kind: { type: 'string', required: true },
            tier: { type: 'string', required: true },
            title: { type: 'string', required: true },
            body: { type: 'string', required: true },
            createdAt: { type: 'number', required: true },
            updatedAt: { type: 'number', required: true },
          },
        },
        render: (_args, value) => text([
          `# ${value.title}`,
          `id ${value.id} · ${value.kind} · tier ${value.tier} · updated ${new Date(value.updatedAt).toISOString()}`,
          '',
          value.body,
        ].join('\n')),
      },
      async execute(args, exec) {
        const { store } = contextFor(exec)
        const result = await store.get(args.id)
        if (!result.ok) throw new Error(result.reason)
        return result.entry
      },
    }),

    defineTool({
      name: 'ledger_search',
      description: [
        'Search recorded project facts by substring over titles and bodies.',
        'Use this when the injected index does not cover what you need: entries beyond the index are still searchable.',
      ].join(' '),
      parameters: {
        query: { type: 'string', required: true, description: 'A term to match, case-insensitively.' },
        limit: { type: 'integer', description: 'Maximum matches; capped by the budget profile.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            matches: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  kind: { type: 'string', required: true },
                  tier: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  excerpt: { type: 'string', required: true },
                },
              },
            },
            total: { type: 'integer', required: true },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => {
          if (value.matches.length === 0) return text('No recorded fact matches that.')
          const lines = value.matches.map(match => (
            `- ${match.title}  [${match.kind} · ${match.tier} · ${match.id}]\n  ${match.excerpt}`
          ))
          return text([
            ...lines,
            value.truncated ? `\nShowing ${value.matches.length} of ${value.total} matches.` : '',
            '\nUse ledger_read with an id for the full entry.',
          ].filter(line => line !== '').join('\n'))
        },
      },
      async execute(args, exec) {
        const { store, budget } = contextFor(exec)
        const requested = positiveCount(args.limit, 'limit') ?? budget.maxSearchResults
        const limit = Math.min(requested, budget.maxSearchResults)
        const result = await store.search(args.query, limit, budget.maxExcerptChars)
        return {
          matches: result.matches,
          total: result.total,
          truncated: result.total > result.matches.length,
        }
      },
    }),

    defineTool({
      name: 'ledger_promote',
      description: [
        'Ask the human to confirm a recorded fact so it is injected into every new session of this project.',
        'Unconfirmed facts stay retrievable but are never injected, because injection is a standing cost.',
        'If no one can answer, the entry stays unconfirmed; report that rather than retrying.',
      ].join(' '),
      parameters: {
        id: { type: 'string', required: true },
        tier: { type: 'string', enum: [...PROMOTABLE_TIERS], description: 'The tier to confirm at; defaults to confirmed.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            promoted: { type: 'boolean', required: true },
            outcome: { type: 'string', required: true },
            tier: { type: 'string', required: true },
            note: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(
          value.promoted
            ? `Confirmed ${value.id} at tier ${value.tier}. It is now injected into new sessions for this project.`
            : `Not promoted: ${value.outcome}. ${value.note}`,
        ),
      },
      async execute(args, exec) {
        const { store, approval, agent } = contextFor(exec)
        const tier = args.tier ?? 'confirmed'
        const existing = await store.get(args.id)
        if (!existing.ok) throw new Error(existing.reason)
        if (approval === undefined) {
          return {
            id: args.id,
            promoted: false,
            outcome: 'unavailable',
            tier: existing.entry.tier,
            note: 'This profile composes no approval surface, so nothing can confirm a fact here.',
          }
        }
        const outcome = await approval.request({
          agent,
          toolName: 'ledger_promote',
          callId: exec.callId,
          reason: `Confirm project fact "${existing.entry.title}" so it is injected into new sessions`,
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          return {
            id: args.id,
            promoted: false,
            outcome,
            tier: existing.entry.tier,
            note: outcome === 'unavailable'
              ? 'No approval surface answered, so the fact stays unconfirmed.'
              : 'The request was not approved, so the fact stays unconfirmed.',
          }
        }
        const promoted = promoteEntry(existing.entry, tier, now())
        await store.put(promoted)
        return { id: args.id, promoted: true, outcome, tier: promoted.tier, note: 'Recorded with its approver.' }
      },
    }),

    defineTool({
      name: 'ledger_status',
      description: [
        'Report this project ledger: the active budget rung and its ceilings, what is recorded by kind and tier,',
        'how many facts are injected versus retrievable only, the size of the injected block, and session token usage.',
        'Under an adaptive profile it also reports the rung in force and the measurement that chose it.',
      ].join(' '),
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectRoot: { type: 'string', required: true },
            profile: { type: 'string', required: true },
            adaptive: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                configured: { type: 'string', required: true },
                rung: { type: 'string', required: true },
                ratio: { type: 'number', required: true },
                usedTokens: { type: 'number' },
                contextWindow: { type: 'number' },
                basis: { type: 'string', required: true },
              },
            },
            ceilings: { type: 'json', required: true },
            total: { type: 'integer', required: true },
            byKind: { type: 'json', required: true },
            byTier: { type: 'json', required: true },
            injected: { type: 'integer', required: true },
            retrievableOnly: { type: 'integer', required: true },
            skippedFiles: { type: 'integer', required: true },
            blockBytes: { type: 'integer', required: true },
            usage: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                usedTokens: { type: 'number' },
                contextWindow: { type: 'number' },
                remainingTokens: { type: 'number' },
                basis: { type: 'string', required: true },
              },
            },
          },
        },
        render: (_args, value) => {
          const { adaptive, usage } = value
          const measured = adaptive.usedTokens === undefined
            ? ''
            : ` from ${adaptive.usedTokens}${adaptive.contextWindow === undefined ? '' : ` of ${adaptive.contextWindow}`} tokens used`
          return text([
            `project: ${value.projectRoot}`,
            `budget: rung ${adaptive.rung}, configured ${adaptive.configured}${measured} (${adaptive.basis})`,
            ...adaptive.rung === 'identity-only'
              ? ['the window has no room for memory headlines, so only the project identity and the catalog are contributed']
              : [],
            `ceilings: ${JSON.stringify(value.ceilings)}`,
            `recorded: ${value.total} total ${JSON.stringify(value.byKind)} tiers ${JSON.stringify(value.byTier)}`,
            `injected: ${value.injected} · retrievable only: ${value.retrievableOnly}`,
            `injected block: ${value.blockBytes} bytes${value.skippedFiles > 0 ? ` · ${value.skippedFiles} unreadable files` : ''}`,
            `session usage: ${usage.usedTokens ?? 'unknown'} tokens used${usage.contextWindow === undefined ? '' : ` of ${usage.contextWindow}`} (${usage.basis})`,
          ].join('\n'))
        },
      },
      async execute(_args, exec) {
        const { store, budget, adaptive, projectRoot, cached, session, tokenMeter, llm } = contextFor(exec)
        const { entries, skipped } = await store.list()
        const census = censusOf(entries)
        const injected = rankForIndex(entries, budget)
        return {
          projectRoot,
          profile: budget.profile,
          adaptive,
          ceilings: { ...budget },
          total: census.total,
          byKind: census.byKind,
          byTier: census.byTier,
          injected: injected.length,
          retrievableOnly: census.total - injected.length,
          skippedFiles: skipped.length,
          blockBytes: Buffer.byteLength(cached.text, 'utf8'),
          usage: await readUsage({ session, tokenMeter, llm, signal: exec.signal }),
        }
      },
    }),

    defineTool({
      name: 'ledger_history',
      description: [
        'List this project\'s archived sessions, most recent first.',
        'Each row is derived mechanically from that session\'s log — duration, turns, tool calls, compactions, how the last turn ended, and the files it touched.',
        'There are no summaries: a row states counts and names, never what the session concluded.',
      ].join(' '),
      parameters: {
        limit: { type: 'integer', description: 'Maximum sessions to return; capped by the budget profile.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rows: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sessionId: { type: 'string', required: true },
                  endedAt: { type: 'number', required: true },
                  turns: { type: 'integer', required: true },
                  toolCalls: { type: 'integer', required: true },
                  compactions: { type: 'integer', required: true },
                  lastTurnReason: { type: 'string' },
                  pathsTouched: { type: 'array', items: { type: 'string' }, required: true },
                  pathsTouchedTotal: { type: 'integer', required: true },
                },
              },
            },
            total: { type: 'integer', required: true },
            truncated: { type: 'boolean', required: true },
            skippedFiles: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => {
          if (value.rows.length === 0) return text('No session of this project has been archived yet.')
          const lines = value.rows.map((row) => {
            const parts = [
              new Date(row.endedAt).toISOString(),
              `${row.turns} turns`,
              `${row.toolCalls} tool calls`,
            ]
            if (row.compactions > 0) parts.push(`${row.compactions} compactions`)
            if (row.lastTurnReason !== undefined) parts.push(`last turn ${row.lastTurnReason}`)
            if (row.pathsTouchedTotal > 0) parts.push(`${row.pathsTouchedTotal} paths`)
            return `- ${row.sessionId} · ${parts.join(' · ')}`
          })
          return text([
            ...lines,
            value.truncated ? `\nShowing ${value.rows.length} of ${value.total} archived sessions.` : '',
          ].filter(line => line !== '').join('\n'))
        },
      },
      async execute(args, exec) {
        const { store, budget } = contextFor(exec)
        const requested = positiveCount(args.limit, 'limit') ?? budget.maxArchiveRows
        const limit = Math.min(requested, budget.maxArchiveRows)
        const { rows, skipped } = await store.listArchive()
        return {
          rows: rows.slice(0, limit).map(row => ({
            sessionId: row.sessionId,
            endedAt: row.endedAt,
            turns: row.turns,
            toolCalls: row.toolCalls,
            compactions: row.compactions,
            ...row.lastTurnReason === undefined ? {} : { lastTurnReason: row.lastTurnReason },
            pathsTouched: [...row.pathsTouched],
            pathsTouchedTotal: row.pathsTouchedTotal,
          })),
          total: rows.length,
          truncated: rows.length > limit,
          skippedFiles: skipped.length,
        }
      },
    }),

    defineTool({
      name: 'ledger_handoff',
      description: [
        'Produce a brief for continuing this project\'s work in a fresh session.',
        'It carries what recent sessions did, mechanically, plus the facts every session of this project already receives.',
        'Start the new session in the same project: it gets the project block and the confirmed facts on its own, so the brief only adds what is in flight.',
        'Use it when this session is close to its context limit, rather than compacting repeatedly.',
      ].join(' '),
      parameters: {
        sessions: { type: 'integer', description: 'How many recent sessions to cover; capped by the budget profile.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            brief: { type: 'string', required: true },
            sessions: { type: 'integer', required: true },
            facts: { type: 'integer', required: true },
            complete: { type: 'boolean', required: true },
            note: { type: 'string', required: true },
          },
        },
        render: (_args, value) => value.complete
          ? text(value.brief)
          : text(`Could not assemble a brief within the byte ceiling. ${value.note}`),
      },
      async execute(args, exec) {
        const { store, budget, projectRoot, cached } = contextFor(exec)
        const requested = positiveCount(args.sessions, 'sessions') ?? budget.maxArchiveRows
        const limit = Math.min(requested, budget.maxArchiveRows)
        const { rows } = await store.listArchive()
        const selected = rows.slice(0, limit)
        const facts = rankForIndex(cached.entries, budget)
        const brief = renderBrief({ projectRoot, rows: selected, facts, budget })
        return {
          brief,
          sessions: selected.length,
          facts: facts.length,
          complete: brief.length > 0,
          // A missing brief is the more important thing to report: it would
          // otherwise be described by a note about the facts it did not carry.
          note: brief.length === 0
            ? 'Even a bare brief exceeded the ceiling; raise maxBriefBytes or select fewer sessions.'
            : selected.length === 0
              ? 'No session of this project has been archived yet, so the brief covers the project facts only.'
              : '',
        }
      },
    }),
  ]
}
