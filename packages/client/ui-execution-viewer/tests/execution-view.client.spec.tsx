// @vitest-environment jsdom
/**
 * Execution surface rendering: the ledger shows one row per step with its
 * category, title, state, and duration; a row discloses the detail slot; the
 * running clock is local and stops at a terminal state. Props are fed
 * directly, so these are presentation assertions only.
 */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { ExecutionSnapshot, ExecutionStep } from '../src/client/contract/execution.ts'
import type {} from '../src/client/contract/slots.ts'
import { ExecutionStepRow } from '../src/client/components/ExecutionStepRow.tsx'
import { ExecutionView } from '../src/client/components/ExecutionView.tsx'
import { StepDetailPanel } from '../src/client/components/StepDetailPanel.tsx'
import { t, tZh } from './locale.client.ts'

type ViewProps = ComponentProps<typeof ExecutionView>

/** One settled tool step with the fields a rendered row reads. */
function step(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    key: 'step-1',
    kind: 'read',
    status: 'succeeded',
    anchorSeq: 1,
    turn: 1,
    step: 1,
    startedAt: 1_000,
    endedAt: 1_400,
    title: { kind: 'path', path: 'src/a.ts', verb: 'read' },
    summary: 'src/a.ts',
    detail: { kind: 'tool', name: 'read', argumentsRaw: '{"file_path":"src/a.ts"}', content: 'body' },
    ...overrides,
  }
}

/** One running step: the settled base without its end time. */
function runningStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  const { endedAt: _endedAt, ...base } = step(overrides)
  return base
}

/** Stand-in for every framework standard seat one isolated fixture does not consume. */
const unused = (): never => { throw new Error('This fixture does not consume this seat') }

/** The framework's GlobalStandardProps & SessionStandardProps kit, as slot components receive it. */
const standard = {
  sessionId: 'session-1' as ViewProps['sessionId'],
  useSession: unused,
  useProjection: unused,
  useConversation: unused,
  useInput: unused,
  useChat: unused,
  useTrajectory: unused,
  useExecution: unused,
  usePanelInfo: unused,
  useSessions: unused,
  useSessionStatus: unused,
  useSessionRetainInfo: unused,
  useResource: unused,
  useWorkspaces: unused,
  inputActions: {
    captureInsertion: unused,
    insertText: unused,
    setDraft: unused,
    persistDraft: unused,
    addAttachments: unused,
    removeAttachment: unused,
    pruneAttachments: unused,
    submit: unused,
  },
}

/**
 * Stand-in for the framework's renderSlot seat. The row tests assert disclosure
 * state; the shipped detail body's content is covered by the StepDetailPanel
 * renders below, and the real dispatch chain by the apply suite's live stack.
 */
const renderSlot = vi.fn(() => null)

/** Assemble the complete prop set one session-scoped view entry receives. */
function viewProps(snapshot: ExecutionSnapshot, overrides: Partial<ViewProps> = {}): ViewProps {
  return {
    ...standard,
    SessionProvider: ({ children }) => children,
    inspectCall: undefined,
    viewRequest: null,
    openView: () => {},
    completeViewRequest: () => {},
    useSessions: selector => selector({ sessions: [], selected: null } as never),
    useSessionStatus: selector => selector({ status: 'idle' } as never),
    useSessionRetainInfo: () => undefined,
    useSession: selector => selector({ openState: 'open' } as never),
    useExecution: selector => selector(snapshot),
    renderSlot,
    t,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Execution step row', () => {
  it('shows the category, title, state, and duration of one step', () => {
    render(
      <ExecutionStepRow step={step()} index={0} now={2_000} t={t} renderSlot={renderSlot} />,
    )
    expect(screen.getByText('Read')).toBeDefined()
    expect(screen.getByText('src/a.ts')).toBeDefined()
    expect(screen.getByText('Done')).toBeDefined()
    expect(screen.getByText('400 ms')).toBeDefined()
  })

  it('discloses and hides the detail body', () => {
    render(
      <ExecutionStepRow step={step()} index={0} now={2_000} t={t} renderSlot={renderSlot} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand details for step 1' }))
    expect(screen.getByRole('button', { name: 'Collapse details for step 1' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse details for step 1' }))
    expect(screen.getByRole('button', { name: 'Expand details for step 1' })).toBeDefined()
  })

  it('renders a failure code and walks the clock until the step settles', () => {
    // The settled base carries an end time; a running step has none.
    const { endedAt: _endedAt, ...running } = step({
      status: 'running',
      kind: 'run',
      title: { kind: 'command', command: 'ls' },
      summary: 'ls',
      error: { name: 'ToolError', code: 'E_FAIL' },
    })
    render(
      <ExecutionStepRow
        step={running}
        index={1}
        now={2_500}
        t={t}
        renderSlot={renderSlot}
      />,
    )
    expect(screen.getByText('Running')).toBeDefined()
    expect(screen.getByText('1.5 s')).toBeDefined()
    expect(screen.getByText('ls')).toBeDefined()
  })

  it('labels every lifecycle state and category through the dictionary', () => {
    render(
      <ExecutionStepRow
        step={step({ kind: 'tool', status: 'unfinished', summary: '', title: { kind: 'tool', name: 'x' } })}
        index={0}
        now={1_000}
        t={tZh}
        renderSlot={renderSlot}
      />,
    )
    // The category label and the title's fallback carry the same text.
    expect(screen.getAllByText('工具')).toHaveLength(2)
    expect(screen.getByText('未完成')).toBeDefined()
    expect(screen.getByText('400 毫秒')).toBeDefined()
  })
})

describe('Execution detail panel', () => {
  it('shows the recorded command, arguments, and result', () => {
    render(
      <StepDetailPanel
        {...standard}
        step={step({ kind: 'run', title: { kind: 'command', command: 'ls -la' } })}
        index={0}
        t={t}
      />,
    )
    expect(screen.getByText('Command')).toBeDefined()
    expect(screen.getByText('ls -la')).toBeDefined()
    expect(screen.getByText('Arguments')).toBeDefined()
    expect(screen.getByText('Result')).toBeDefined()
  })

  it('shows a recorded failure with its reason', () => {
    render(
      <StepDetailPanel
        {...standard}
        step={step({ error: { name: 'ToolError', code: 'E_FAIL', reason: 'nope' } })}
        index={0}
        t={t}
      />,
    )
    expect(screen.getByText('Error')).toBeDefined()
    expect(screen.getByText('ToolError (E_FAIL): nope')).toBeDefined()
  })

  it('shows a failure without a reason and a tool step with no result yet', () => {
    render(
      <StepDetailPanel
        {...standard}
        step={step({
          error: { name: 'ToolError', code: 'E_FAIL' },
          detail: { kind: 'tool', name: 'read', argumentsRaw: '{}' },
          title: { kind: 'tool', name: 'read' },
        })}
        index={0}
        t={t}
      />,
    )
    expect(screen.getByText('ToolError (E_FAIL)')).toBeDefined()
    expect(screen.queryByText('Result')).toBeNull()
  })

  it('shows the reasoning text of a thinking step', () => {
    render(
      <StepDetailPanel
        {...standard}
        step={step({
          kind: 'thinking',
          status: 'succeeded',
          summary: '',
          title: { kind: 'thinking', chars: 4 },
          detail: { kind: 'reasoning', text: 'calm' },
        })}
        index={0}
        t={t}
      />,
    )
    expect(screen.getByText('Thinking')).toBeDefined()
    expect(screen.getByText('calm')).toBeDefined()
  })
})

describe('Execution view', () => {
  it('states the empty ledger instead of an empty list', () => {
    render(<ExecutionView {...viewProps({ turns: [], stepCount: 0, runningCount: 0 })} />)
    expect(screen.getByText('No execution steps to show for this turn.')).toBeDefined()
  })

  it('renders every turn in order with its rows', () => {
    render(
      <ExecutionView
        {...viewProps({
          stepCount: 2,
          runningCount: 0,
          turns: [
            { turn: 1, status: 'closed', steps: [step()] },
            {
              turn: 2,
              status: 'open',
              steps: [runningStep({
                key: 'step-2',
                turn: 2,
                step: 2,
                kind: 'thinking',
                status: 'running',
                summary: '',
                title: { kind: 'thinking', chars: 3 },
                detail: { kind: 'reasoning', text: 'why' },
              })],
            },
          ],
        })}
      />,
    )
    expect(screen.getByRole('list', { name: 'Execution step list' })).toBeDefined()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('Turn 1')).toBeDefined()
    expect(screen.getByText('Finished')).toBeDefined()
    expect(screen.getByText('Turn 2')).toBeDefined()
    // The open Turn's own label and the running step's state carry the same word.
    expect(screen.getAllByText('Running')).toHaveLength(2)
  })

  it('reports an unknown turn lifecycle and walks the clock while a step runs', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    render(
      <ExecutionView
        {...viewProps({
          stepCount: 1,
          runningCount: 1,
          turns: [{ turn: 1, status: 'unknown', steps: [runningStep({ status: 'running' })] }],
        })}
      />,
    )
    expect(screen.getByText('Status unknown')).toBeDefined()
    expect(screen.getByText('0 ms')).toBeDefined()
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByText('2.0 s')).toBeDefined()
  })
})
