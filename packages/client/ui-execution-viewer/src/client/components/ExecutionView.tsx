/**
 * Execution view: a flat, Turn-partitioned ledger of one Session's steps.
 * The ledger reads only its target snapshot and the framework-provided seats,
 * so it holds no subscription of its own; the running clock is local state.
 */
import { useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExecutionTurn } from '../contract/execution.ts'
import type { ExecutionTranslate } from '../locales.ts'
import { ExecutionStepRow } from './ExecutionStepRow.tsx'
import css from './execution.module.css'

/**
 * One Turn's header: its number and lifecycle.
 * @param props - the Turn and the view's translate seat.
 */
export function ExecutionTurnHeader({
  turn, t,
}: {
  readonly turn: ExecutionTurn
  readonly t: ExecutionTranslate
}) {
  const statusKey = turn.status === 'open'
    ? 'turn.open'
    : turn.status === 'closed' ? 'turn.closed' : 'turn.unknown'
  return (
    <div className={css.turnHeader}>
      <span className={css.turnTitle}>{t('turn.label', { turn: turn.turn })}</span>
      <span className={css.turnStatus}>{t(statusKey)}</span>
    </div>
  )
}

/**
 * Render the Execution ledger for the bound Session.
 * @param props - framework-derived view props, the locale seat, and the detail slot.
 */
export function ExecutionView({
  useExecution, renderSlot, t,
}: ConvViewProps
  & PropsRenderSlots<'conversation.execution.detail'>
  & PropsLocale<'execution'>) {
  const snapshot = useExecution(value => value)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (snapshot.runningCount === 0) return undefined
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [snapshot.runningCount])
  if (snapshot.turns.length === 0) {
    return <div className={css.view}><p className={css.empty}>{t('view.empty')}</p></div>
  }
  return (
    <div className={css.view} role="list" aria-label={t('view.aria')}>
      {snapshot.turns.map(turn => (
        <section className={css.turn} key={turn.turn}>
          <ExecutionTurnHeader turn={turn} t={t} />
          {turn.steps.map((step, index) => (
            <ExecutionStepRow
              key={step.key}
              step={step}
              index={index}
              now={now}
              t={t}
              renderSlot={renderSlot}
            />
          ))}
        </section>
      ))}
    </div>
  )
}
