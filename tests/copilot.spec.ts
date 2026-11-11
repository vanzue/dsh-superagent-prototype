import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AcpOptions } from '../src/infra/acp.ts'
import { KV } from '../src/kv.ts'
import { latestAssignment } from '../src/core/index.ts'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'

const connections = vi.hoisted(() => [] as {
  options: AcpOptions; requests: { method: string; params: Record<string, unknown> }[]
  finish(): void; fail(): void; closed: boolean
}[])
vi.mock('../src/infra/acp.ts', () => ({
  AcpClient: class {
    entry: typeof connections[number]
    resolve?: (value: unknown) => void
    reject?: (error: Error) => void
    constructor(options: AcpOptions) {
      this.entry = { options, requests: [], closed: false,
        finish: () => this.resolve?.({ stopReason: 'end_turn' }), fail: () => this.reject?.(new Error('lost connection')) }
      connections.push(this.entry)
    }
    request(method: string, params: Record<string, unknown>) {
      this.entry.requests.push({ method, params })
      if (method === 'initialize') return Promise.resolve({ agentCapabilities: { loadSession: true } })
      if (method === 'session/new') return Promise.resolve({ sessionId: `copilot-${connections.length}` })
      if (method === 'session/load') return Promise.resolve({})
      return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    }
    async close() { this.entry.closed = true; this.reject?.(new Error('closed')) }
  },
}))
let h: Host
beforeEach(async () => {
  connections.length = 0
  h = await startRuntime()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, backend: 'copilot',
    copilot: { executable: process.execPath, home: '', model: 'auto' } } })
})
afterEach(async () => { await h.stop() })
const prompted = (count = 1) => connections.length >= count && connections[count - 1]!.requests.some(call => call.method === 'session/prompt')
async function call(connection: typeof connections[number], method: string, params?: unknown, authenticated = true) {
  const open = connection.requests.find(call => call.method === 'session/new' || call.method === 'session/load')!
  const [mcp] = open.params.mcpServers as { url: string; headers: { name: string; value: string }[] }[]
  const response = await fetch(mcp!.url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? Object.fromEntries(mcp!.headers.map(header => [header.name, header.value])) : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { status: response.status, body: response.status === 200 ? await response.json() as { result: { isError?: boolean; content?: { text: string }[]; tools?: unknown[] } } : undefined }
}
it('runs a Copilot worker without creating a DSH worker; end_turn alone is not business completion', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix a typo'))
  await waitUntil(() => prompted())
  expect(h.runtime.store.tickets.get(ticket.id)?.execution?.backend).toBe('copilot')
  expect(h.agents.has(sessionId)).toBe(false)
  expect(h.runtime.executor.activeCount()).toBe(1)
  expect(h.runtime.store.get(KV.copilot.session(ticket.id))?.inFlight).toBeDefined()
  expect(connections[0]!.options.permission({ sessionId: 'copilot-1' })).toBe(true)
  expect(connections[0]!.options.permission({ sessionId: 'some-other-session' })).toBe(false)
  expect(connections[0]!.options.permission({ sessionId: 'copilot-1', toolCall: { rawInput: { detach: true } } })).toBe(false)
  connections[0]!.finish()
  await waitUntil(() => h.runtime.executor.activeCount() === 0)
  const updated = h.runtime.store.tickets.get(ticket.id)!
  expect(updated.ended).toBeUndefined()
  expect(latestAssignment(updated)?.report?.state).toBe('waiting')
  expect(h.runtime.store.get(KV.copilot.session(ticket.id))).toMatchObject({ seeded: true, sessionId: 'copilot-1' })
})
it('authenticates MCP, limits its tools and ticket resources, and delivers a real Engine report', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix a typo'))
  await waitUntil(() => prompted())
  const connection = connections[0]!
  expect((await call(connection, 'tools/list', undefined, false)).status).toBe(401)
  const listed = await call(connection, 'tools/list')
  expect(listed.body?.result.tools).toHaveLength(6)
  const forbidden = await call(connection, 'tools/call', { name: 'orchestrator_read', arguments: { resource: 'ticket/another' } })
  expect(forbidden.body?.result.isError).toBe(true)
  const reported = await call(connection, 'tools/call', { name: 'orchestrator_report', arguments: { state: 'ready', summary: 'Fixed.' } })
  expect(reported.body?.result.isError).not.toBe(true)
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  const stale = await call(connection, 'tools/call', { name: 'orchestrator_report', arguments: { state: 'progress', summary: 'Too late' } })
  expect(stale.body?.result.isError).toBe(true)
  expect(connection.options.permission({})).toBe(false)
  connection.finish()
  await waitUntil(() => h.runtime.executor.activeCount() === 0)
  expect((await call(connection, 'tools/list')).status).toBe(401)
})
it('retains the ticket backend and session when the default changes, queuing followups until idle', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix a typo'))
  await waitUntil(() => prompted())
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, backend: 'dsh' } })
  h.runtime.receive(feishu('2', 'also fix punctuation', { root_id: 'om_1', mentions: [] }))
  await h.runtime.pump()
  expect(connections).toHaveLength(1)
  connections[0]!.finish()
  await waitUntil(() => h.runtime.executor.activeCount() === 0)
  await h.runtime.executor.copilot.deliverQueued(ticket.id)
  await waitUntil(() => prompted(2))
  expect(connections[1]!.requests.find(call => call.method === 'session/load')?.params.sessionId).toBe('copilot-1')
  expect(h.agents.has(`worker-${ticket.id}`)).toBe(false)
  connections[1]!.finish()
  await waitUntil(() => h.runtime.executor.activeCount() === 0)
  expect(h.runtime.store.tickets.get(ticket.id)?.undelivered).toEqual([])
})
it('does not replay an uncertain send after resume, and revokes a stopped assignment', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix a typo'))
  await waitUntil(() => prompted())
  connections[0]!.fail()
  await waitUntil(() => h.runtime.executor.activeCount() === 0)
  const before = h.runtime.store.get(KV.copilot.session(ticket.id))
  expect(before).toMatchObject({ uncertain: true })
  h.runtime.executor.resume()
  await h.runtime.pump()
  expect(connections).toHaveLength(1)
  const updated = h.runtime.store.tickets.get(ticket.id)!
  expect(latestAssignment(updated)?.report?.state).toBe('failed')
  h.runtime.engine.retryTicket(ticket.id)
  await h.runtime.pump()
  await waitUntil(() => prompted(2))
  expect(connections[1]!.requests.some(call => call.method === 'session/load')).toBe(true)
  h.runtime.engine.stopTicket(ticket.id)
  await waitUntil(() => h.runtime.executor.activeCount() === 0)
  expect(connections[1]!.closed).toBe(true)
  expect(connections[1]!.options.permission({})).toBe(false)
})
it('ends a turn at a blocking report, rather than allowing it to invent its own human reply', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot verify and wait for me'))
  await waitUntil(() => prompted())
  const connection = connections[0]!
  const reported = await call(connection, 'tools/call', { name: 'orchestrator_report',
    arguments: { state: 'blocked', summary: 'First round done.', human_action: 'Please continue explicitly.' } })
  expect(reported.body?.result.isError).not.toBe(true)
  expect(connection.options.permission({})).toBe(false)
  await waitUntil(() => h.runtime.executor.activeCount() === 0)
  expect(connection.closed).toBe(true)
  expect(h.runtime.store.get(KV.copilot.session(ticket.id))?.inFlight).toBeUndefined()
  h.runtime.executor.resume()
  await h.runtime.pump()
  expect(connections).toHaveLength(1)
  expect(latestAssignment(h.runtime.store.tickets.get(ticket.id)!)?.report?.state).toBe('blocked')
})
it('shares capacity across DSH and Copilot workers', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, backend: 'dsh', maxWorkers: 1 } })
  await h.acceptedTicket(feishu('1', '@bot fix a typo'))
  const next = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...next, executor: { ...next.executor, backend: 'copilot' } })
  const { ticket } = await h.acceptedTicket(feishu('2', '@bot fix another typo'))
  expect(latestAssignment(h.runtime.store.tickets.get(ticket.id)!)?.state).toBe('pending')
  expect(connections).toHaveLength(0)
  expect(h.runtime.executor.activeCount()).toBe(1)
})
it('admits a human followup in the shared extra slot without redelivering inputs after the report', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix a typo'))
  await waitUntil(() => prompted())
  connections[0]!.finish()
  await waitUntil(() => h.runtime.executor.activeCount() === 0)
  const next = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...next, executor: { ...next.executor, backend: 'dsh' } })
  await h.acceptedTicket(feishu('3', '@bot fix another typo'))
  h.runtime.receive(feishu('2', 'continue please', { root_id: 'om_1', mentions: [] }))
  await h.runtime.pump()
  await waitUntil(() => prompted(2))
  expect(h.runtime.executor.activeCount()).toBe(2)
  await call(connections[1]!, 'tools/call', { name: 'orchestrator_report', arguments: { state: 'blocked', summary: 'Need clarification.' } })
  const deliveredAt = latestAssignment(h.runtime.store.tickets.get(ticket.id)!)?.deliveredAt
  expect(h.runtime.store.tickets.get(ticket.id)?.undelivered).toEqual([])
  connections[1]!.finish()
  await waitUntil(() => h.runtime.executor.activeCount() === 1)
  expect(latestAssignment(h.runtime.store.tickets.get(ticket.id)!)?.deliveredAt).toBe(deliveredAt)
})
