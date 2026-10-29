// A stand-in ACP agent for the transport tests: NDJSON JSON-RPC on stdio, one
// long-lived process, one session per `session/new`, and a prompt answered as a
// thinking update plus text updates that name the call this process has served.
// The call number is per process, so a second call answered with `call:2`
// proves the same child served both; a served `session/load` is named too, so a
// call answered from a reloaded session proves the conversation survived.
//
// A session id names a session in the stand-in's own store, so `session/load`
// accepts any id it ever handed out. `FAKE_ACP_FORGET=1` models a CLI that kept
// no such store: every load is refused and only `session/new` works.
//
// `FAKE_ACP_STOP` is the stop reason a prompt answers with, `FAKE_ACP_ERROR` the
// failure detail a CLI reports beside it, and `FAKE_ACP_REPORT_CWD=1` makes the
// answer name the directory this process started in — the workspace a real CLI
// takes from its own cwd rather than from `session/new`.
import process from 'node:process'

let buffer = ''
let calls = 0
let sessions = 0
let loads = 0
const forget = process.env.FAKE_ACP_FORGET === '1'
const stopReason = process.env.FAKE_ACP_STOP ?? 'end_turn'
const errorMessage = process.env.FAKE_ACP_ERROR
const cwdNote = process.env.FAKE_ACP_REPORT_CWD === '1' ? ` cwd:${process.cwd()}` : ''
const argvNote = process.env.FAKE_ACP_REPORT_ARGV === '1' ? ` argv:${process.argv.slice(2).join(' ')}` : ''
// A run that never converges: the prompt stays open until the client cancels
// it, which is the only thing a delegated turn's deadline can act on.
const stall = process.env.FAKE_ACP_STALL === '1'
let stalledPromptId

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

function handle(message) {
  if (message.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: !forget } },
    })
    return
  }
  if (message.method === 'session/new') {
    sessions += 1
    // The handshake carries the CLI's own catalog, which is the only listing
    // that also discloses each model's input capacity.
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        sessionId: `session-${sessions}`,
        models: {
          availableModels: [
            { modelId: 'acp-one', name: 'ACP One', _meta: { maxInputTokens: 200000 } },
            { modelId: 'acp-two' },
          ],
        },
      },
    })
    return
  }
  if (message.method === 'session/load') {
    const { sessionId } = message.params ?? {}
    if (forget || !/^session-\d+$/u.test(sessionId ?? '')) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'unknown session' } })
      return
    }
    loads += 1
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
    return
  }
  if (message.method === 'session/prompt') {
    const { sessionId, prompt } = message.params
    calls += 1
    const update = (update) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
    if (process.env.FAKE_ACP_SUBAGENT === '1') {
      const _meta = { 'codebuddy.ai/parentToolCallId': 'delegated-tool' }
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'subagent thinking' }, _meta })
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'subagent conclusion' }, _meta })
    }
    if (stall) {
      if (process.env.FAKE_ACP_STALL_TEXT === '1') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer before completion' } })
      }
      stalledPromptId = message.id
      return
    }
    const loadNote = loads > 0 ? ` loaded:${loads}` : ''
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `call:${calls} ${sessionId}${loadNote}${cwdNote}${argvNote} ` } })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: prompt[0].text } })
    if (process.env.FAKE_ACP_REPEAT_BLOCKS === '1') {
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'follow-up thinking' } })
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'final answer' } })
    }
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        stopReason,
        ...errorMessage === undefined ? {} : { _meta: { 'codebuddy.ai/errorMessage': errorMessage } },
      },
    })
    return
  }
  if (message.method === 'session/cancel') {
    if (stalledPromptId !== undefined) {
      write({ jsonrpc: '2.0', id: stalledPromptId, result: { stopReason: 'cancelled' } })
      stalledPromptId = undefined
    }
    return
  }
  if (typeof message.id === 'number') {
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } })
  }
}

process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline === -1) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line.length > 0) handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => { process.exit(0) })
