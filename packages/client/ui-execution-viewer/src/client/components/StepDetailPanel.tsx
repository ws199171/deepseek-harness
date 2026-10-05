/**
 * Shipped detail body of one expanded Execution step: the recorded command,
 * arguments, result, failure, and reasoning text, each labelled through the
 * view's dictionary. This component is the default occupant of the
 * `conversation.execution.detail` slot; a deployment may replace it.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExecutionStepError } from '../contract/execution.ts'
import css from './execution.module.css'

/** Framework-derived props of the shipped detail panel. */
export type ExecutionDetailProps =
  PropsRuntime<'conversation.execution.detail'> & PropsLocale<'execution'>

/**
 * Render a recorded failure as one line of text.
 * @param error - the recorded failure.
 * @returns `name`, code, and the optional reason.
 */
function errorText(error: ExecutionStepError): string {
  return error.reason === undefined
    ? `${error.name} (${error.code})`
    : `${error.name} (${error.code}): ${error.reason}`
}

/** Reasoning text kept verbatim in a scrollable, line-preserving block. */
export function ReasoningText({ text }: { readonly text: string }) {
  return <pre className={css.reasoning}>{text}</pre>
}

/** One labelled block of recorded detail. */
function DetailField({
  label, value, tone,
}: {
  readonly label: string
  readonly value: string
  readonly tone?: 'error'
}) {
  return (
    <div className={css.field} data-tone={tone ?? 'plain'}>
      <p className={css.detailLabel}>{label}</p>
      <pre className={css.detailValue}>{value}</pre>
    </div>
  )
}

/**
 * Render one step's complete recorded detail.
 * @param props - the step to expand, its position, and the locale seat.
 */
export function StepDetailPanel({ step, t }: ExecutionDetailProps) {
  if (step.detail.kind === 'reasoning') {
    return (
      <div className={css.detailBody}>
        <p className={css.detailLabel}>{t('detail.reasoning')}</p>
        <ReasoningText text={step.detail.text} />
      </div>
    )
  }
  const fields = (
    <>
      {step.title.kind === 'command'
        ? <DetailField label={t('detail.command')} value={step.title.command} />
        : null}
      <DetailField label={t('detail.arguments')} value={step.detail.argumentsRaw} />
      {step.detail.content === undefined
        ? null
        : <DetailField label={t('detail.result')} value={step.detail.content} />}
      {step.error === undefined
        ? null
        : <DetailField label={t('detail.error')} value={errorText(step.error)} tone="error" />}
    </>
  )
  return <div className={css.detailBody}>{fields}</div>
}
