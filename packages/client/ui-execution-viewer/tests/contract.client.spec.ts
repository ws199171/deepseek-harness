/**
 * Pure contract behavior: tool-name classification, structured titles, bounded
 * summaries, argument parsing, and result text.
 */
import { describe, expect, it } from 'vitest'
import { stepKindForTool } from '../src/client/contract/classify.ts'
import type { ExecutionSnapshot, ExecutionViewNode } from '../src/client/contract/execution.ts'
import {
  boundStreamedArguments, contentText, parseArguments, stepTitle, summaryOf,
} from '../src/client/contract/format.ts'
import { ExecutionViewBuilder } from '../src/client/view/builder.ts'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'

describe('tool-name classification', () => {
  it('maps every recorded tool name to its step category', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['read', 'read'],
      ['read_image', 'readImage'],
      ['glob', 'list'],
      ['grep', 'search'],
      ['fs_inspect', 'search'],
      ['write', 'write'],
      ['edit', 'edit'],
      ['apply_patch', 'edit'],
      ['bash', 'run'],
      ['pwsh', 'run'],
      ['exec_command', 'run'],
      ['write_stdin', 'run'],
      ['terminal_read', 'run'],
      ['run_code', 'code'],
      ['web_search', 'webSearch'],
      ['web_fetch', 'webFetch'],
      ['subagent', 'subagent'],
      ['subagent_research', 'subagent'],
      ['todo_write', 'plan'],
      ['create_goal', 'plan'],
      ['update_goal', 'plan'],
      ['get_goal', 'plan'],
      ['ask_user_question', 'questions'],
      ['request_user_input', 'questions'],
      ['mcp__vendor__act', 'tool'],
    ]
    for (const [name, kind] of cases) expect([name, stepKindForTool(name)]).toEqual([name, kind])
  })
})

describe('structured titles', () => {
  it('reads the recorded field each category needs', () => {
    expect(stepTitle('read', 'read', '{"file_path":"src/a.ts"}')).toEqual({ kind: 'path', path: 'src/a.ts', verb: 'read' })
    expect(stepTitle('readImage', 'read_image', '{"path":"a.png"}')).toEqual({ kind: 'path', path: 'a.png', verb: 'read' })
    expect(stepTitle('write', 'write', '{"file_path":"out.txt"}')).toEqual({ kind: 'path', path: 'out.txt', verb: 'write' })
    expect(stepTitle('edit', 'edit', '{"path":"e.ts"}')).toEqual({ kind: 'path', path: 'e.ts', verb: 'edit' })
    expect(stepTitle('run', 'bash', '{"command":"ls -la"}')).toEqual({ kind: 'command', command: 'ls -la' })
    expect(stepTitle('run', 'bash', '{"cmd":"pwd"}')).toEqual({ kind: 'command', command: 'pwd' })
    expect(stepTitle('search', 'grep', '{"pattern":"needle"}')).toEqual({ kind: 'query', query: 'needle' })
    expect(stepTitle('list', 'glob', '{"query":"src/**"}')).toEqual({ kind: 'query', query: 'src/**' })
    expect(stepTitle('webSearch', 'web_search', '{"queries":["a","b"]}')).toEqual({ kind: 'query', query: 'a, b' })
    expect(stepTitle('webFetch', 'web_fetch', '{"url":"https://example.test"}')).toEqual({ kind: 'url', url: 'https://example.test' })
    expect(stepTitle('webFetch', 'web_fetch', '{"uri":"https://example.test/b"}')).toEqual({ kind: 'url', url: 'https://example.test/b' })
  })

  it('falls back to the recorded tool name when the expected field is absent', () => {
    expect(stepTitle('read', 'read', '{}')).toEqual({ kind: 'tool', name: 'read' })
    expect(stepTitle('write', 'write', '{}')).toEqual({ kind: 'tool', name: 'write' })
    expect(stepTitle('edit', 'edit', '{}')).toEqual({ kind: 'tool', name: 'edit' })
    expect(stepTitle('run', 'bash', 'not json')).toEqual({ kind: 'tool', name: 'bash' })
    expect(stepTitle('search', 'grep', '{}')).toEqual({ kind: 'tool', name: 'grep' })
    expect(stepTitle('webFetch', 'web_fetch', '{}')).toEqual({ kind: 'tool', name: 'web_fetch' })
    expect(stepTitle('tool', 'mcp__vendor__act', '{"x":1}')).toEqual({ kind: 'tool', name: 'mcp__vendor__act' })
    expect(stepTitle('plan', 'todo_write', '')).toEqual({ kind: 'tool', name: 'todo_write' })
  })

  it('ignores blank and non-string candidate values', () => {
    expect(stepTitle('read', 'read', '{"file_path":"  "}')).toEqual({ kind: 'tool', name: 'read' })
    expect(stepTitle('read', 'read', '{"path":7}')).toEqual({ kind: 'tool', name: 'read' })
  })

  it('summarizes each title through its data part', () => {
    expect(summaryOf({ kind: 'path', path: 'p', verb: 'read' })).toBe('p')
    expect(summaryOf({ kind: 'command', command: 'c' })).toBe('c')
    expect(summaryOf({ kind: 'query', query: 'q' })).toBe('q')
    expect(summaryOf({ kind: 'url', url: 'u' })).toBe('u')
    expect(summaryOf({ kind: 'tool', name: 'n' })).toBe('n')
    expect(summaryOf({ kind: 'thinking', chars: 3 })).toBe('')
  })

  it('bounds a long summary on a grapheme boundary', () => {
    const long = 'x'.repeat(200)
    const bounded = summaryOf({ kind: 'tool', name: long })
    expect(bounded).toHaveLength(160)
    expect(bounded.endsWith('…')).toBe(true)
  })
})

describe('argument and result text', () => {
  it('parses only JSON objects', () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 })
    expect(parseArguments('[1]')).toBeNull()
    expect(parseArguments('7')).toBeNull()
    expect(parseArguments('null')).toBeNull()
    expect(parseArguments('{')).toBeNull()
  })

  it('bounds accumulated streamed arguments', () => {
    expect(boundStreamedArguments('abc')).toBe('abc')
    const long = boundStreamedArguments('y'.repeat(3_000))
    expect(long).toHaveLength(2_048)
  })

  it('renders text blocks verbatim and other blocks as JSON', () => {
    expect(contentText([{ type: 'text', text: 'line' }, { type: 'text', text: 'two' }])).toBe('line\ntwo')
    expect(contentText([{ type: 'reasoning', text: 'r' } as never])).toContain('"type":"reasoning"')
    expect(contentText([])).toBe('')
  })
})

/** A timeline with no turns. */
const NO_TURNS: ConversationTimelineSnapshot = { turnOrder: [], turns: new Map() }

/** One node of the target ledger. */
function node(key: string, anchorSeq: number, turn: number, status: 'succeeded' | 'running'): ExecutionViewNode {
  return {
    key,
    kind: 'execution-step',
    id: key,
    target: 'execution',
    anchorSeq,
    turn,
    data: {
      key,
      kind: 'read',
      status,
      anchorSeq,
      turn,
      step: 1,
      startedAt: 1,
      title: { kind: 'tool', name: 'read' },
      summary: 'read',
      detail: { kind: 'tool', name: 'read', argumentsRaw: '{}' },
    },
  }
}

/** One timeline carrying the supplied turn statuses. */
function timeline(statuses: readonly (readonly [number, 'open' | 'closed' | 'unknown'])[]): ConversationTimelineSnapshot {
  return {
    turnOrder: statuses.map(([turn]) => turn),
    turns: new Map(statuses.map(([turn, status]) => [turn, {
      turn, start: undefined, end: undefined, status, steps: [], data: {} as never,
    }])),
  }
}

describe('Execution ledger builder', () => {
  it('orders by anchor, breaks ties by key, and partitions by turn', () => {
    const builder = new ExecutionViewBuilder()
    const snapshot: ExecutionSnapshot = builder.replace({
      nodes: [node('b', 2, 1, 'succeeded'), node('a', 2, 1, 'succeeded'), node('c', 1, 2, 'succeeded')],
      timeline: timeline([[1, 'closed'], [2, 'open']]),
    })
    expect(snapshot.turns.map(turn => turn.turn)).toEqual([1, 2])
    expect(snapshot.turns[0]?.steps.map(step => step.key)).toEqual(['a', 'b'])
    expect(snapshot.stepCount).toBe(3)
    expect(snapshot.runningCount).toBe(0)
    expect(builder.empty).toEqual({ turns: [], stepCount: 0, runningCount: 0 })
  })

  it('reports an unknown turn lifecycle when the timeline omits the turn', () => {
    const builder = new ExecutionViewBuilder()
    const snapshot = builder.replace({ nodes: [node('a', 1, 7, 'succeeded')], timeline: NO_TURNS })
    expect(snapshot.turns[0]?.status).toBe('unknown')
  })

  it('merges changed nodes and drops the ones a replacement omits', () => {
    const builder = new ExecutionViewBuilder()
    builder.replace({ nodes: [node('a', 1, 1, 'running')], timeline: timeline([[1, 'open']]) })
    const merged = builder.apply({ upserts: [node('a', 1, 1, 'succeeded'), node('b', 5, 1, 'running')], timeline: timeline([[1, 'open']]) })
    expect(merged.stepCount).toBe(2)
    expect(merged.runningCount).toBe(1)
    const replaced = builder.replace({ nodes: [node('b', 5, 1, 'succeeded')], timeline: timeline([[1, 'closed']]) })
    expect(replaced.stepCount).toBe(1)
    expect(replaced.turns[0]?.steps.map(step => step.key)).toEqual(['b'])
  })

  it('keeps a reasoning run running in a closed turn and derives only tool steps as unfinished', () => {
    const builder = new ExecutionViewBuilder()
    const thinking: ExecutionViewNode = {
      ...node('t', 1, 1, 'running'),
      kind: 'execution-thinking',
      data: {
        ...node('t', 1, 1, 'running').data,
        kind: 'thinking',
        summary: '',
        title: { kind: 'thinking', chars: 1 },
        detail: { kind: 'reasoning', text: 'x' },
      },
    }
    const snapshot = builder.replace({
      nodes: [thinking, node('a', 2, 1, 'running')],
      timeline: timeline([[1, 'closed']]),
    })
    expect(snapshot.turns[0]?.steps.map(step => step.status)).toEqual(['running', 'unfinished'])
  })
})
