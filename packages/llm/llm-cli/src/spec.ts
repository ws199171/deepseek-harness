/**
 * Wire schemas and types for the CLI discovery Remote service exposed by the
 * `llm-cli` plugin. The Host service lives behind {@link @deepseek-ai/dsh-llm-cli}
 * as a `TypertRemoteService`; the renderer calls its `discover` and `test`
 * methods through the `api.llm.cliDiscover` / `api.llm.cliTest` surfaces
 * Typert generates from the schemas below.
 *
 * @module @deepseek-ai/dsh-llm-cli/spec
 */

import { z } from 'zod'

/** A supported CLI probe entry: what executable to look for and how to call it. */
export const cliCandidateSchema = z.object({
  /** Stable CLI id used by the UI (currently `codebuddy`). */
  id: z.string().min(1),
  /** Human-readable label shown in the picker. */
  displayName: z.string().min(1),
  /** Candidate executable names, in resolution order; the first that resolves wins. */
  commands: z.array(z.string().min(1)).min(1),
  /** Args that produce the version string (e.g. `['--version']`). The first line of stdout is parsed. */
  versionArgs: z.array(z.string()).default([]),
  /** Args that print the CLI's supported model ids without starting an agent session. */
  modelDiscoveryArgs: z.array(z.string()).default([]),
  /**
   * Args that, paired with a tiny prompt, prove the CLI answers the harness's
   * `assistant`/`result` stream-json protocol without committing to a full
   * agentic run. A successful probe emits a `result` event within the grace.
   */
  probeArgs: z.array(z.string()).default([]),
  /** Hard ceiling in ms for the probe run. */
  probeTimeoutMs: z.number().int().positive().default(15_000),
})

/** The supported CLI probe entry as it appears in the registry. */
export type CliCandidate = z.infer<typeof cliCandidateSchema>

/** Whether the CLI was found on this host. */
export const cliPresenceSchema = z.enum(['present', 'absent'])
/** Whether the executable was resolved on this host. */
export type CliPresence = z.infer<typeof cliPresenceSchema>

/** Health verdict from a probe run. */
export const cliHealthSchema = z.enum(['unknown', 'healthy', 'broken'])
/** Protocol verdict from an explicit probe. */
export type CliHealth = z.infer<typeof cliHealthSchema>

/** One model id advertised by an installed CLI. */
export const cliModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
})

/** One model advertised by the CLI discovery response. */
export type CliModel = z.infer<typeof cliModelSchema>

/** One discovered CLI: probe entry plus the facts the host could establish. */
export const cliDiscoveredSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  presence: cliPresenceSchema,
  /** Candidate executable names the discovery looked for, in resolution order. */
  commands: z.array(z.string().min(1)).min(1),
  /** Resolved executable path, when present. */
  path: z.string().optional(),
  /** Captured version line, when present. */
  version: z.string().optional(),
  /** Model ids the installed CLI reports as valid for its model flag. */
  models: z.array(cliModelSchema),
  /** Why model discovery returned no usable ids. */
  modelDetail: z.string().optional(),
  /** Lightweight probe verdict for the stream-json protocol. */
  health: cliHealthSchema,
  /** Failure detail when health is `broken` or presence is `absent`. */
  detail: z.string().optional(),
})

/** One discovered CLI as returned to the renderer. */
export type CliDiscovered = z.infer<typeof cliDiscoveredSchema>

/** Result returned by `discover`. */
export const cliDiscoverResultSchema = z.object({
  entries: z.array(cliDiscoveredSchema),
})
/** Inferred type of {@link cliDiscoverResultSchema}. */
export type CliDiscoverResultView = z.infer<typeof cliDiscoverResultSchema>

/** Request shape for `test`. */
export const cliTestRequestSchema = z.object({
  id: z.string().min(1),
  /** Optional override; absence picks the first `commands` entry the probe resolves. */
  command: z.string().min(1).optional(),
  /** Additional arguments appended after the candidate's probeArgs. */
  extraArgs: z.array(z.string()).default([]),
})

/** A single test invocation's result. */
export const cliTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  /** Captured stream-json stdout snippet when the probe emitted something. */
  preview: z.string().optional(),
})

/** Input for one supported CLI probe. */
export type CliTestRequest = z.infer<typeof cliTestRequestSchema>
/** Outcome of one supported CLI probe. */
export type CliTestResult = z.infer<typeof cliTestResultSchema>
