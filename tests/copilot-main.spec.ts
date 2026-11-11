import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AcpOptions } from '../src/infra/acp.ts'
import { key } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'

const connections = vi.hoisted(() => [] as {
  options: AcpOptions; requests: { method: string; params: Record<string, unknown> }[]
  finish(): void; fail(): void; receive(): void; closed: boolean
}[])
vi.mock('../src/infra/acp.ts', () => ({
  AcpClient: class {
    entry: typeof connections[number]
    resolve?: (value: unknown) => void
    reject?: (error: Error) => void
    constructor(options: AcpOptions) {
      this.entry = { options, requests: [], closed: false,
        finish: () => this.resolve?.({ stopReason: 'end_turn' }), fail: () => this.reject?.(new Error('lost connection')),
        receive: () => options.notification({ method: 'session/update', params: { sessionId: 'main-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Routing the request.' } } } }),
      }
      connections.push(this.entry)
    }
    request(method: string, params: Record<string, unknown>) {
      this.entry.requests.push({ method, params })
      if (method === 'initialize') return Promise.resolve({ agentCapabilities: { loadSession: true } })
      if (method === 'session/new') return Promise.resolve({ sessionId: 'main-session' })
      if (method === 'session/load') return Promise.resolve({})
      return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    }
    async close() { this.entry.closed = true; this.reject?.(new Error('closed')) }
  },
}))
let h: Host
beforeEach(async () => {
  connections.length = 0
  h = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, eval: { ...settings.eval, backend: 'copilot',
      copilot: { executable: process.execPath, home: '', model: 'auto' } } })
  })
})
afterEach(async () => { await h.stop() })
const prompted = (count = 1) => connections[count - 1]?.requests.some(call => call.method === 'session/prompt')
async function call(connection: typeof connections[number], method: string, params?: unknown, authenticated = true) {
  const open = connection.requests.find(call => call.method === 'session/new' || call.method === 'session/load')!
  const [mcp] = open.params.mcpServers as { url: string; headers: { name: string; value: string }[] }[]
  const response = await fetch(mcp!.url, { method: 'POST', headers: { 'content-type': 'application/json',
    ...authenticated ? Object.fromEntries(mcp!.headers.map(header => [header.name, header.value])) : {} },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { status: response.status, body: response.status === 200 ? await response.json() as {
    result: { isError?: boolean; content?: { text: string }[]; tools?: { name: string }[] }
  } : undefined }
}
async function enqueue(id = 'first') {
  await expect(h.runtime.main!.prompt(id, '{"kind":"candidate"}')).rejects.toThrow('Waiting')
  await waitUntil(() => !!prompted())
}

it('does not create a DSH main Session or wake Copilot for configuration notices', async () => {
  expect(h.agents.has(h.runtime.masterId)).toBe(false)
  expect(connections).toEqual([])
  h.runtime.sessions.notify('settings', { paused: false }, 'Settings changed')
  await h.runtime.effects.idle('notice')
  expect(connections).toEqual([])
  await enqueue()
  const options = connections[0]!.options
  expect(options.argv.find(arg => arg.startsWith('--available-tools='))).toContain('superagent-orchestrator_route')
  expect(options.argv.find(arg => arg.startsWith('--available-tools='))).not.toContain('orchestrator_settings_save')
  expect(options.permission({ sessionId: 'main-session', toolCall: { kind: 'execute' } })).toBe(false)
  expect(options.permission({ sessionId: 'another', toolCall: { kind: 'other' } })).toBe(false)
  expect(options.permission({ sessionId: 'main-session', toolCall: { kind: 'other' } })).toBe(true)
  connections[0]!.finish()
  await h.runtime.effects.idle('main-turn')
  expect(options.permission({ sessionId: 'main-session', toolCall: { kind: 'other' } })).toBe(false)
})

it('authenticates main MCP and routes a real Engine candidate without a DSH main agent', async () => {
  const trigger = feishu('1', 'Please fix the typo')
  h.runtime.receive(trigger)
  await waitUntil(() => !!prompted())
  const connection = connections[0]!
  expect((await call(connection, 'tools/list', undefined, false)).status).toBe(401)
  const listed = await call(connection, 'tools/list')
  const names = listed.body!.result.tools!.map(tool => tool.name)
  expect(names).toContain('orchestrator_route')
  expect(names).not.toContain('orchestrator_report')
  expect(names).not.toContain('orchestrator_settings_save')
  const routed = await call(connection, 'tools/call', { name: 'orchestrator_route', arguments: {
    decisions: [{ kind: 'accept', trigger_id: trigger.id, title: 'Fix typo', worktree_name: 'fix-typo', acknowledgement: 'Fixing the typo.' }],
  } })
  expect(routed.body!.result.isError).not.toBe(true)
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(h.agents.has(h.runtime.masterId)).toBe(false)
  connection.finish()
  await h.runtime.effects.idle('main-turn')
  expect((await call(connection, 'tools/list')).status).toBe(401)
})

it('serializes turns, marks delivery on receipt, deduplicates sends and loads the same session for followups', async () => {
  await enqueue()
  h.runtime.sessions.relay('second', 'Worker report: ready')
  await waitUntil(() => h.runtime.effects.pending('main-turn', 'second'))
  expect(connections).toHaveLength(1)
  expect(h.runtime.main!.holds('first')).toBe(false)
  connections[0]!.receive()
  expect(h.runtime.main!.holds('first')).toBe(true)
  await h.runtime.main!.prompt('first', 'Do not duplicate this')
  connections[0]!.finish()
  await waitUntil(() => !!prompted(2))
  expect(connections[1]!.requests.find(call => call.method === 'session/load')?.params.sessionId).toBe('main-session')
  connections[1]!.finish()
  await h.runtime.effects.idle('main-turn')
  expect(h.runtime.store.get(KV.copilotMain.receipt(key('second')))).toBe('done')
})

it('answers a human question through the normal outbox and returns its persisted receipt', async () => {
  const trigger = feishu('question', 'Which repository do you operate on?')
  h.runtime.receive(trigger)
  await waitUntil(() => !!prompted())
  const result = await call(connections[0]!, 'tools/call', { name: 'orchestrator_reply', arguments: {
    trigger_id: trigger.id, purpose: 'answer', text: 'I operate on the configured fork.',
  } })
  expect(result.body!.result.isError).not.toBe(true)
  expect(JSON.parse(result.body!.result.content![0]!.text)).toEqual({ status: 'sent' })
  connections[0]!.finish()
  await h.runtime.effects.idle('main-turn')
})

it('holds uncertain sends until panel recovery without replaying the interrupted request', async () => {
  await enqueue()
  connections[0]!.fail()
  await waitUntil(() => !!h.runtime.main!.status().uncertain && !h.runtime.main!.status().running)
  h.runtime.main!.resume()
  await expect(h.runtime.main!.prompt('first', 'Never replay')).rejects.toThrow('Waiting')
  await expect(h.runtime.main!.prompt('second', 'New authorized request')).rejects.toThrow('Waiting')
  await h.runtime.effects.idle('main-turn')
  expect(connections).toHaveLength(1)
  h.runtime.main!.recover()
  await waitUntil(() => !!prompted(2))
  const prompt = connections[1]!.requests.find(call => call.method === 'session/prompt')!.params.prompt as { text: string }[]
  expect(prompt[0]!.text).toContain('Recovery:')
  expect(prompt[0]!.text).toContain('New authorized request')
  expect(prompt[0]!.text.endsWith('\nNew authorized request')).toBe(true)
  connections[1]!.finish()
  await h.runtime.effects.idle('main-turn')
  expect(h.runtime.main!.holds('first')).toBe(true)
})

it('does not start while paused and rejects main tool mutations immediately when paused mid-turn', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, paused: true })
  await expect(h.runtime.main!.prompt('first', 'Wait')).rejects.toThrow('Waiting')
  await h.runtime.effects.idle('main-turn')
  expect(connections).toEqual([])
  h.runtime.store.saveSettings({ ...settings, paused: false })
  h.runtime.effects.kick()
  await waitUntil(() => !!prompted())
  h.runtime.store.saveSettings({ ...settings, paused: true })
  const denied = await call(connections[0]!, 'tools/call', { name: 'orchestrator_ticket_note', arguments: { ticket_id: 'any', text: 'No' } })
  expect(denied.body?.result.isError).toBe(true)
  connections[0]!.finish()
  await h.runtime.effects.idle('main-turn')
})

it('restores a persisted ACP session after a process restart and requires inspection of an interrupted turn', async () => {
  await h.stop()
  h = await startRuntime(store => {
    const settings = store.settings(), config = { executable: process.execPath, home: '', model: 'auto' }
    store.saveSettings({ ...settings, eval: { ...settings.eval, backend: 'copilot', copilot: config } })
    store.set(KV.copilotMain.state, { config, sessionId: 'persisted-main', seeded: true, inFlight: 'before-restart' })
  })
  expect(h.runtime.main!.status()).toMatchObject({ uncertain: true, sessionId: 'persisted-main' })
  expect(connections).toEqual([])
  await expect(h.runtime.main!.prompt('new', 'New request')).rejects.toThrow('Waiting')
  h.runtime.main!.recover()
  await waitUntil(() => !!prompted())
  expect(connections[0]!.requests.find(call => call.method === 'session/load')?.params.sessionId).toBe('persisted-main')
  connections[0]!.finish()
  await h.runtime.effects.idle('main-turn')
})
