/** Stateless, authenticated, ticket-scoped MCP tools on a loopback-only listener. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { z } from 'zod'
import type { Tool } from '../app/tools/tool.ts'

export type McpTool = Tool & { inputSchema?: Record<string, unknown> }
interface Scope { token: string; tools: McpTool[]; authorize(): void; signal: AbortSignal }
/** Serves revocable, assignment-scoped tool sets without exposing the host's other tools. */
export class WorkerMcp {
  private readonly scopes = new Map<string, Scope>()
  private readonly server: Server
  private readonly ready: Promise<number>
  constructor() {
    this.server = createServer((request, response) => {
      const send = (status: number, value?: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(value === undefined ? undefined : JSON.stringify(value))
      }
      void this.handle(request).then(result => send(result.status, result.body),
        () => send(400, { error: 'Invalid MCP request' }))
    })
    this.ready = new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as { port: number }).port))
    })
    this.server.unref()
  }
  async open(id: string, tools: McpTool[], authorize: () => void, signal: AbortSignal) {
    const port = await this.ready, token = randomBytes(32).toString('hex')
    const scope = { token, tools, authorize, signal }
    this.scopes.set(id, scope)
    return {
      config: { type: 'http', name: 'superagent', url: `http://127.0.0.1:${port}/mcp/${id}`,
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }] },
      close: () => { if (this.scopes.get(id) === scope) this.scopes.delete(id) },
    }
  }
  private async handle(request: IncomingMessage): Promise<{ status: number; body?: unknown }> {
    const port = await this.ready
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin) return { status: 403 }
    const scope = this.scopes.get((request.url ?? '').replace(/^\/mcp\//, ''))
    const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '')
    const expected = Buffer.from(scope?.token ?? '')
    if (!scope || !expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return { status: 401 }
    if (request.method === 'DELETE') return { status: 204 }
    if (request.method !== 'POST') return { status: 405 }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const data = Buffer.from(chunk as Uint8Array); size += data.length
      if (size > 1_048_576) return { status: 413 }
      chunks.push(data)
    }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      jsonrpc: string; id?: string | number; method: string; params?: Record<string, unknown>
    }
    if (message.jsonrpc !== '2.0') return { status: 400 }
    if (message.id === undefined) return { status: 202 }
    const reply = (result: unknown) => ({ status: 200, body: { jsonrpc: '2.0', id: message.id, result } })
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} },
      serverInfo: { name: 'dsh-superagent-worker', version: '0.1.0' } })
    if (message.method === 'ping') return reply({})
    try {
      scope.signal.throwIfAborted(); scope.authorize()
      if (message.method === 'tools/list') return reply({ tools: scope.tools.map(tool => ({
        name: tool.name, description: tool.description,
        inputSchema: tool.inputSchema ?? z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }),
      })) })
      if (message.method === 'tools/call') {
        const tool = scope.tools.find(tool => tool.name === message.params?.name)
        if (!tool) throw new Error('Unknown worker tool')
        const args = tool.schema.parse(message.params?.arguments ?? {})
        const value = await tool.execute(args, scope.signal)
        return reply({ content: [{ type: 'text', text: JSON.stringify(value ?? null) }] })
      }
    } catch (error) {
      return reply({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Worker tool failed' }] })
    }
    return { status: 200, body: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } } }
  }
  async close(): Promise<void> {
    this.scopes.clear()
    await this.ready
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}
