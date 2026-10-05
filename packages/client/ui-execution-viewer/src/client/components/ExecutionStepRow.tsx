/**
 * One ledger row: category mark, category label, one-line title, lifecycle
 * state, and duration, with a disclosure that renders the detail slot.
 * The disclosure is component-local: nothing outside the row reads it.
 */
import { useState } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExecutionStep, ExecutionStepKind, ExecutionStepStatus } from '../contract/execution.ts'
import type { ExecutionKey, ExecutionTranslate } from '../locales.ts'
import css from './execution.module.css'

/** Render-slot seat for one step's expanded detail body. */
type DetailSlot = PropsRenderSlots<'conversation.execution.detail'>['renderSlot']

/** Localized label of every step category. */
const KIND_KEYS: Record<ExecutionStepKind, ExecutionKey> = {
  thinking: 'kind.thinking',
  read: 'kind.read',
  readImage: 'kind.readImage',
  search: 'kind.search',
  list: 'kind.list',
  write: 'kind.write',
  edit: 'kind.edit',
  run: 'kind.run',
  code: 'kind.code',
  webSearch: 'kind.webSearch',
  webFetch: 'kind.webFetch',
  subagent: 'kind.subagent',
  plan: 'kind.plan',
  questions: 'kind.questions',
  tool: 'kind.tool',
}

/** Localized label of every lifecycle state a row can show. */
const STATUS_KEYS: Record<ExecutionStepStatus, ExecutionKey> = {
  preparing: 'status.preparing',
  running: 'status.running',
  succeeded: 'status.succeeded',
  failed: 'status.failed',
  unfinished: 'status.unfinished',
  interrupted: 'status.interrupted',
}

/**
 * Render one duration in the unit that keeps it readable.
 * @param milliseconds - non-negative elapsed milliseconds.
 * @param t - view translate seat.
 * @returns localized duration text.
 */
function formatDuration(milliseconds: number, t: ExecutionTranslate): string {
  if (milliseconds < 1000) return t('duration.milliseconds', { milliseconds })
  return t('duration.seconds', { seconds: (milliseconds / 1000).toFixed(1) })
}

/** Visual mark distinguishing one step category from another. */
export function StepGlyph({ kind }: { readonly kind: ExecutionStepKind }) {
  return <span className={css.glyph} data-kind={kind} aria-hidden="true" />
}

/** The row's category label. */
export function StepKindLabel({ kind, t }: { readonly kind: ExecutionStepKind; readonly t: ExecutionTranslate }) {
  return <span className={css.kind}>{t(KIND_KEYS[kind])}</span>
}

/** The row's one-line title: the bounded recorded value, or the category alone. */
export function StepTitleLine({ step, t }: { readonly step: ExecutionStep; readonly t: ExecutionTranslate }) {
  return (
    <span className={css.title}>
      {step.summary === '' ? t(KIND_KEYS[step.kind]) : step.summary}
    </span>
  )
}

/** The row's lifecycle state. */
export function StepStatusLabel({
  status, t,
}: {
  readonly status: ExecutionStepStatus
  readonly t: ExecutionTranslate
}) {
  return <span className={css.status}>{t(STATUS_KEYS[status])}</span>
}

/** The row's duration, walking the clock while the step has not settled. */
export function StepDurationLabel({
  step, now, t,
}: {
  readonly step: ExecutionStep
  readonly now: number
  readonly t: ExecutionTranslate
}) {
  return <span className={css.duration}>{formatDuration(Math.max(0, (step.endedAt ?? now) - step.startedAt), t)}</span>
}

/**
 * Render one step of the Execution ledger.
 * @param props - the step, its position, the local clock, and framework seats.
 */
export function ExecutionStepRow({
  step, index, now, t, renderSlot,
}: {
  readonly step: ExecutionStep
  readonly index: number
  readonly now: number
  readonly t: ExecutionTranslate
  readonly renderSlot: DetailSlot
}) {
  const [expanded, setExpanded] = useState(false)
  const label = expanded
    ? t('row.collapse', { index: index + 1 })
    : t('row.expand', { index: index + 1 })
  return (
    <div className={css.row} data-status={step.status} role="listitem">
      <button
        type="button"
        className={css.rowButton}
        aria-expanded={expanded}
        aria-label={label}
        onClick={() => { setExpanded(value => !value) }}
      >
        <StepGlyph kind={step.kind} />
        <StepKindLabel kind={step.kind} t={t} />
        <StepTitleLine step={step} t={t} />
        <StepStatusLabel status={step.status} t={t} />
        <StepDurationLabel step={step} now={now} t={t} />
      </button>
      {expanded
        ? <div className={css.detail}>{renderSlot('conversation.execution.detail', { step, index })}</div>
        : null}
    </div>
  )
}
