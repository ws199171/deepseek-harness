/**
 * One conversion from a caught value to reportable text.
 *
 * Every `catch` in this package records a reason rather than rethrowing, and a
 * caught value is not guaranteed to be an `Error`. Keeping the conversion here
 * means the untyped branch is written and covered once instead of four times.
 *
 * @module @deepseek-ai/dsh-context-ledger/errors
 */

/**
 * Read a message from a caught value.
 *
 * @param error - The caught value, which need not be an `Error`.
 * @returns Its message, or its string form when it is not an `Error`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
