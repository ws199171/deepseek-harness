/**
 * The CLI provider panel: the `llm-cli` layout of the provider editor card.
 * It runs the Host-side CLI discovery Remote (`llm-cli-discovery/discover`)
 * to enumerate supported CLI programs installed on this machine, shows
 * a presence/health dot per entry (green installed-and-probed, red absent or
 * broken, gray unknown), and lets the user adopt one — writing its executable
 * name and reported model ids into the draft. The editor's Apply commits them
 * as settings path ops, and the conversation's model picker receives the
 * discovered catalog on its next refresh.
 * A per-entry probe button runs `llm-cli-discovery/test` to verify the
 * stream-json protocol without a full model call.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { CliDiscovered, CliTestResult } from '@deepseek-ai/dsh-llm-cli/types'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The Remote face this panel consumes (methods return {@link RemoteResult}). */
export interface CliDiscoveryRemote {
  discover: () => Promise<RemoteResult<{ entries: CliDiscovered[] }>>
  test: (request: { id: string; extraArgs: string[] }) => Promise<RemoteResult<CliTestResult>>
}

/** A carrier-level failure for the degrade-to-hint face. */
function unavailable(message: string): RemoteFailure {
  return { code: 'missing-remote', message, details: {} }
}

/**
 * The degrade face used when the client assembly did not mount the CLI
 * discovery Remote: both methods answer with a carrier failure, so the panel
 * renders its hint instead of a broken call.
 */
export function unavailableCliRemote(): CliDiscoveryRemote {
  return {
    discover: () => Promise.resolve({ ok: false, error: unavailable('CLI discovery is unavailable in this client assembly.') }),
    test: () => Promise.resolve({ ok: false, error: unavailable('CLI probing is unavailable in this client assembly.') }),
  }
}

/** Per-entry probe state owned by the panel. */
type ProbeState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; ok: boolean; message: string }

/** One entry row's derived status dot. */
export type CliDot = 'green' | 'red' | 'gray'

/** Props of {@link CliProviderPanel}. */
export interface CliProviderPanelProps {
  /** The discovery/test Remote face. */
  cliRemote: CliDiscoveryRemote
  /** The currently drafted command (empty string when unset). */
  command: string
  /** The currently drafted model catalog. */
  models: readonly CliDiscovered['models'][number][]
  /** Adopt a candidate: write its executable into the draft. */
  onAdopt: (candidate: CliDiscovered) => void
  /** Whether every control is disabled (read-only settings or busy apply). */
  disabled: boolean
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** The status dot of one discovery entry. */
export function dotOf(entry: CliDiscovered, probe: ProbeState | undefined): CliDot {
  if (entry.presence === 'absent') return 'red'
  if (probe !== undefined && probe.kind === 'done') return probe.ok ? 'green' : 'red'
  if (entry.health === 'healthy') return 'green'
  if (entry.health === 'broken') return 'red'
  return 'gray'
}

/** The dot's screen-reader text. */
export function dotLabel(entry: CliDiscovered, probe: ProbeState | undefined): string {
  if (entry.presence === 'absent') return 'missing'
  if (probe !== undefined && probe.kind === 'done') return probe.ok ? 'healthy' : 'broken'
  if (entry.health === 'healthy') return 'healthy'
  if (entry.health === 'broken') return 'broken'
  return 'unknown'
}

/** Whether the saved catalog contains exactly the model ids discovered for one CLI. */
function sameModels(left: readonly CliDiscovered['models'][number][], right: readonly CliDiscovered['models'][number][]): boolean {
  return left.length === right.length && left.every((model, index) => {
    const other = right[index]
    return other !== undefined && model.id === other.id && model.name === other.name
  })
}

/**
 * Render the CLI delegation editor body.
 * @param props - remote face, draft command, adopt callback, copy.
 * @returns the panel.
 */
export function CliProviderPanel(props: CliProviderPanelProps): ReactNode {
  const { cliRemote, command, models, onAdopt, disabled, t } = props
  const [entries, setEntries] = useState<CliDiscovered[] | undefined>(undefined)
  const [detecting, setDetecting] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeState>>(new Map())

  const detect = async (): Promise<void> => {
    setDetecting(true)
    setFailure(undefined)
    try {
      const carried = await cliRemote.discover()
      if (!carried.ok) {
        setFailure(carried.error.message)
        return
      }
      setEntries(carried.value.entries)
    } catch (error) {
      // A transport rejection (disconnect) must surface as text, not as an
      // unhandled rejection that would leave the button spinning.
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setDetecting(false)
    }
  }

  const runProbe = async (entry: CliDiscovered): Promise<void> => {
    setProbes(current => new Map(current).set(entry.id, { kind: 'running' }))
    try {
      const carried = await cliRemote.test({ id: entry.id, extraArgs: [] })
      const done: ProbeState = carried.ok
        ? { kind: 'done', ok: carried.value.ok, message: carried.value.message }
        : { kind: 'done', ok: false, message: carried.error.message }
      setProbes(current => new Map(current).set(entry.id, done))
    } catch (error) {
      const done: ProbeState = {
        kind: 'done',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
      setProbes(current => new Map(current).set(entry.id, done))
    }
  }

  return (
    <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('cliEditorTitle')}</span>
      <p className={styles['advancedHint']}>{t('cliSelectHint')}</p>
      {entries === undefined
        ? (
          <button
            className={styles['secondaryButton']}
            type="button"
            disabled={disabled || detecting}
            onClick={() => { void detect() }}
          >
            {detecting ? t('cliDetecting') : t('cliDetect')}
          </button>
        )
        : null}
      {entries !== undefined && entries.length === 0
        ? <p className={styles['advancedHint']}>{t('cliDetectNone')}</p>
        : null}
      {entries !== undefined && entries.length > 0
        ? (
          <ul className={styles['cliList']}>
            {entries.map((entry) => {
              const probe = probes.get(entry.id)
              const dot = dotOf(entry, probe)
              const label = dotLabel(entry, probe)
              const adopted = entry.presence === 'present'
                && (entry.path === command || entry.commands.some(name => name === command))
                && sameModels(entry.models, models)
              const present = entry.presence === 'present'
              return (
                <li key={entry.id} className={styles['cliRow']}>
                  <span
                    className={`${styles['cliDot']} ${dot === 'green' ? styles['cliDotGreen'] : ''} ${dot === 'red' ? styles['cliDotRed'] : ''}`}
                    role="img"
                    aria-label={label}
                  />
                  <span className={styles['cliName']}>{entry.displayName}</span>
                  {present && entry.version !== undefined
                    ? <span className={styles['cliMeta']}>{entry.version}</span>
                    : null}
                  {present && entry.path !== undefined
                    ? <span className={styles['cliMeta']} title={entry.path}>{entry.path}</span>
                    : null}
                  {present && entry.models.length > 0
                    ? <p className={styles['advancedHint']}>{`${t('cliModels')}: ${entry.models.map(model => model.name ?? model.id).join(', ')}`}</p>
                    : null}
                  <span className={styles['cliActions']}>
                    {present
                      ? (
                        <button
                          className={styles['linkButton']}
                          type="button"
                          disabled={disabled || probe?.kind === 'running'}
                          onClick={() => { void runProbe(entry) }}
                        >
                          {probe?.kind === 'running' ? t('cliProbing').replace('{cli}', entry.displayName) : t('cliRunProbe')}
                        </button>
                      )
                      : null}
                    {present
                      ? (
                        <button
                          className={adopted ? styles['primaryButton'] : styles['secondaryButton']}
                          type="button"
                          disabled={disabled || adopted}
                          onClick={() => { onAdopt(entry) }}
                        >
                          {adopted ? t('apply') : t('cliAdopt')}
                        </button>
                      )
                      : null}
                  </span>
                  {probe !== undefined && probe.kind === 'done'
                    ? <p className={probe.ok ? styles['savedNotice'] : styles['error']}>{probe.message}</p>
                    : null}
                  {entry.detail !== undefined && entry.presence === 'absent'
                    ? <p className={styles['advancedHint']}>{entry.detail}</p>
                    : null}
                  {entry.modelDetail !== undefined && present
                    ? <p className={styles['error']}>{entry.modelDetail}</p>
                    : null}
                </li>
              )
            })}
          </ul>
        )
        : null}
      {entries !== undefined
        ? (
          <button
            className={styles['linkButton']}
            type="button"
            disabled={disabled || detecting}
            onClick={() => { void detect() }}
          >
            {t('cliDetect')}
          </button>
        )
        : null}
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
    </div>
  )
}
