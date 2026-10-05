/** Tool-name to step-category classification owned by the Execution view. */
import type { ExecutionStepKind } from './execution.ts'

/** Tools whose step is a shell or process run. */
const RUN_TOOLS = new Set(['bash', 'pwsh', 'exec_command', 'write_stdin'])

/** Tools whose step is planning bookkeeping. */
const PLAN_TOOLS = new Set(['todo_write', 'create_goal', 'update_goal', 'get_goal'])

/** Tools whose step asks the human a question. */
const QUESTION_TOOLS = new Set(['ask_user_question', 'request_user_input'])

/** Suffix marking an inspection tool as a search. */
const INSPECT_SUFFIX = '_inspect'

/** Prefix marking a terminal tool as a run. */
const TERMINAL_PREFIX = 'terminal_'

/** Prefix marking a delegated-agent tool. */
const SUBAGENT_PREFIX = 'subagent_'

/**
 * Classify one tool name into its Execution step category.
 *
 * The mapping mirrors Chat's process categories so both surfaces agree on what
 * a step is. Tool names are open, so an unknown name is a legitimate `tool`
 * step that keeps its recorded name.
 * @param name - recorded tool name, verbatim from `tool/call`.
 * @returns the step category for that tool.
 */
export function stepKindForTool(name: string): ExecutionStepKind {
  if (name === 'read') return 'read'
  if (name === 'read_image') return 'readImage'
  if (name === 'glob') return 'list'
  if (name === 'grep' || name.endsWith(INSPECT_SUFFIX)) return 'search'
  if (name === 'write') return 'write'
  if (name === 'edit' || name === 'apply_patch') return 'edit'
  if (RUN_TOOLS.has(name) || name.startsWith(TERMINAL_PREFIX)) return 'run'
  if (name === 'run_code') return 'code'
  if (name === 'web_search') return 'webSearch'
  if (name === 'web_fetch') return 'webFetch'
  if (name === 'subagent' || name.startsWith(SUBAGENT_PREFIX)) return 'subagent'
  if (PLAN_TOOLS.has(name)) return 'plan'
  if (QUESTION_TOOLS.has(name)) return 'questions'
  return 'tool'
}
