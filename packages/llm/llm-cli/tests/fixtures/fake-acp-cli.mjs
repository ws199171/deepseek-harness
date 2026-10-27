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
import process from 'node:process'

let buffer = ''
let calls = 0
let sessions = 0
let loads = 0
const forget = process.env.FAKE_ACP_FORGET === '1'

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
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: `session-${sessions}` } })
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
    const loadNote = loads > 0 ? ` loaded:${loads}` : ''
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `call:${calls} ${sessionId}${loadNote} ` } })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: prompt[0].text } })
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (message.method === 'session/cancel') return
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
