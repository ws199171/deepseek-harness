/**
 * Public client-visible types for the `llm-cli` plugin. The Host-side service
 * returns these shapes from its Remote methods; the renderer (and any test)
 * imports them from the `./types` subpath so the cordis boundary stays clean.
 *
 * @module @deepseek-ai/dsh-llm-cli/types
 */

export type {
  CliCandidate,
  CliDiscovered,
  CliDiscoverResultView,
  CliModel,
  CliPresence,
  CliHealth,
  CliTestRequest,
  CliTestResult,
} from './spec.ts'
