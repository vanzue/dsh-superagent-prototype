/** Host Chat inference, MCP proposals, cancellation and auxiliary calls without API-key providers. */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { AcpOptions } from '../src/infra/acp.ts'
import { CopilotModel } from '../src/llm/copilot.ts'
import { waitUntil } from './fixtures/async.ts'

const connections = vi.hoisted(() => [] as {
  options: AcpOptions; requests: { method: string; params: Record<string, unknown> }[]
  finish(): void; text(text: string): void; closed: boolean
}[])
vi.mock('../src/infra/acp.ts', () => ({
  AcpClient: class {
    entry: typeof connections[number]
    resolve?: (value: unknown) => void
    reject?: (error: Error) => void
    constructor(options: AcpOptions) {
      this.entry = { options, requests: [], closed: false,
        finish: () => this.resolve?.({ stopReason: 'end_turn' }),
        text: text => options.notification({ method: 'session/update', params: { sessionId: 'inference',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }),
      }
      connections.push(this.entry)
    }
    request(method: string, params: Record<string, unknown>) {
      this.entry.requests.push({ method, params })
      if (method === 'initialize') return Promise.resolve({ agentCapabilities: { promptCapabilities: { image: true } } })
      if (method === 'session/new') return Promise.resolve({ sessionId: 'inference' })
      return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    }
    async close() { this.entry.closed = true; this.reject?.(new Error('closed')) }
  },
}))
let directory: string, adapter: CopilotModel
const readImage = vi.fn<AttachmentStore['readImage']>()
beforeEach(() => {
  connections.length = 0
  directory = mkdtempSync(join(tmpdir(), 'copilot-model-'))
  adapter = new CopilotModel({ directory, executable: process.execPath }, { readImage })
})
afterEach(async () => { await adapter.shutdown(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs() })
const options = (extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: 'copilot', model: 'auto', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }], ...extra,
})
async function collect(request: GenerateOptions) {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk)
  return chunks
}
async function started(index = 0) {
  await waitUntil(() => !!connections[index]?.requests.some(call => call.method === 'session/prompt'))
  return connections[index]!
}

it.each([undefined, 'session-title', 'compaction'] as const)('uses Copilot for %s requests and streams ordinary host text', async purpose => {
  vi.stubEnv('OPENROUTER_API_KEY', 'not-used')
  const result = collect(options({ ...purpose ? { purpose } : {} }))
  const connection = await started()
  expect(connection.options.env.OPENROUTER_API_KEY).toBeUndefined()
  expect(connection.options.argv).toContain('--available-tools=__no_host_tools__')
  expect(connection.options.permission({ sessionId: 'inference', toolCall: { kind: 'execute' } })).toBe(false)
  connection.text('Info: Disabled tools: powershell, view')
  connection.text('Info: Unknown tool name in the tool allowlist: "__no_host_tools__"')
  connection.text('Hello'); connection.text(' from Copilot'); connection.finish()
  const chunks = await result
  expect(chunks.filter(chunk => chunk.type === 'text-delta')).toHaveLength(2)
  expect(chunks.at(-2)).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello from Copilot' } })
  expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  expect(connection.closed).toBe(true)
  expect(readdirSync(directory)).toEqual([])
})

it('returns a native MCP tool proposal, not its execution, and sends actual host results in the next request', async () => {
  const tool = { name: 'read', description: 'Read a host file', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
  } }
  const result = collect(options({ tools: [tool] }))
  const connection = await started()
  const [mcp] = connection.requests.find(call => call.method === 'session/new')!.params.mcpServers as {
    url: string; headers: { name: string; value: string }[]
  }[]
  const headers = { 'content-type': 'application/json', ...Object.fromEntries(mcp!.headers.map(h => [h.name, h.value])) }
  const list = await (await fetch(mcp!.url, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json() as { result: { tools: { inputSchema: unknown }[] } }
  expect(list.result.tools[0]!.inputSchema).toEqual(tool.parameters)
  expect(connection.options.argv).toContain('--available-tools=superagent-read')
  expect(connection.options.permission({ sessionId: 'inference', toolCall: { kind: 'other' } })).toBe(true)
  const call = fetch(mcp!.url, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { path: 'example.txt' } } }) })
    .catch(() => undefined)
  const chunks = await result
  await call
  const block = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  expect(block).toMatchObject({ block: { name: 'read', arguments: '{"path":"example.txt"}' } })
  expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  expect(connection.options.permission({ sessionId: 'inference', toolCall: { kind: 'other' } })).toBe(false)
  const followup = collect(options({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Host result: actual file content' }] }] }))
  const next = await started(1)
  expect(JSON.stringify(next.requests.find(call => call.method === 'session/prompt')!.params.prompt)).toContain('actual file content')
  next.text('The file contains the supplied host result.'); next.finish()
  await followup
  expect(readdirSync(directory)).toEqual([])
})

it('cancels the owned inference process and never completes a cancelled tool proposal', async () => {
  const abort = new AbortController()
  const result = collect(options({ signal: abort.signal })).catch(error => error as Error)
  const connection = await started()
  connection.text('Partial')
  abort.abort(new Error('Cancelled by user'))
  expect(await result).toBeInstanceOf(Error)
  expect(connection.closed).toBe(true)
  expect(readdirSync(directory)).toEqual([])
})

it('does not silently replace images with guessed text', async () => {
  readImage.mockRejectedValueOnce(new Error('Attachment not available'))
  await expect(collect(options({ messages: [{ role: 'user', content: [
    { type: 'image', attachment: {} as never },
  ] }] }))).rejects.toThrow('Attachment not available')
  expect(connections).toEqual([])
})
