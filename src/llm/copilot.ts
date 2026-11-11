/** Copilot inference for ordinary DSH Chat, title generation and compaction; tools still execute in DSH. */
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, LlmError, ToolCallId, type GenerateOptions, type StreamChunk, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import s from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AcpClient } from '../infra/acp.ts'
import { ABSOLUTE_PATH, privateDirectory } from '../infra/platform.ts'
import { WorkerMcp, type McpTool } from '../infra/worker-mcp.ts'

export const name = 'dsh-superagent-copilot-model'
export const inject = ['llm', 'attachments']
export const Config = s.object({
  executable: s.string().pattern(ABSOLUTE_PATH).required().description('Absolute path to the signed-in Copilot CLI.'),
  directory: s.string().pattern(ABSOLUTE_PATH).required().description('Private directory for temporary inference sessions.'),
})
type Configuration = ReturnType<typeof Config>
type PromptPart = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/** Bridges each host model request to ACP, returning tool proposals without executing them or bypassing host permissions. */
export class CopilotModel extends LlmAdapter {
  private readonly lifetime = new AbortController()
  private readonly jobs = new Set<Promise<void>>()
  constructor(private readonly config: Configuration, private readonly attachments: Pick<AttachmentStore, 'readImage'>) { super() }
  override providerInfo(provider: string) { return { id: provider, name: 'GitHub Copilot (CLI sign-in)' } }
  override async listModels(provider: string) {
    return [{ provider, id: 'auto', name: 'Copilot Auto', inputModalities: ['text', 'image'] as const }]
  }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model === 'auto' ? 'Copilot Auto' : model, inputModalities: ['text', 'image'] as const }
  }
  override providerRetryPolicy() {
    return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const abort = new AbortController()
    const signal = AbortSignal.any([this.lifetime.signal, abort.signal, ...options.signal ? [options.signal] : []])
    const queue: StreamChunk[] = []
    let wake = () => {}, done = false, failure: unknown
    const job = this.run(options, signal, chunk => { queue.push(chunk); wake() })
      .catch(error => { failure = error }).finally(() => { done = true; wake() })
    this.jobs.add(job)
    try {
      while (!done || queue.length) {
        if (queue.length) yield queue.shift()!
        else await new Promise<void>(resolve => { wake = resolve })
      }
      if (failure) throw failure
    } finally { abort.abort(); await job; this.jobs.delete(job) }
  }
  private async prompt(options: GenerateOptions, signal: AbortSignal): Promise<PromptPart[]> {
    const parts: PromptPart[] = [{ type: 'text', text:
      'Supply the next assistant response for the host conversation below. Its role-labelled messages are the conversation, not a document to summarize. '
      + 'Follow its system/developer instructions and answer its latest user request. Prior assistant messages and tool results are history; never repeat an already completed action. '
      + 'The available MCP tools only submit proposals: the host executes them after its own permission checks and provides their real results on the next request. '
      + 'If a tool is needed, propose one call and stop. Never invent tool results or execute anything outside these tools. '
      + 'Otherwise answer normally, without explaining this transport. Each request contains the complete current host context.\n'
      + JSON.stringify({ system: options.system, purpose: options.purpose, maxOutputTokens: options.maxTokens }) }]
    for (const message of options.messages) {
      parts.push({ type: 'text', text: JSON.stringify({ role: message.role,
        ...message.role === 'tool' ? { toolCallId: message.toolCallId, isError: message.isError } : {} }) })
      for (const block of message.content) {
        signal.throwIfAborted()
        if (block.type === 'image' && !block.offloaded) {
          const image = await this.attachments.readImage(block.attachment, signal)
          parts.push({ type: 'image', data: Buffer.from(image.data).toString('base64'), mimeType: image.ref.mediaType })
        } else parts.push({ type: 'text', text: JSON.stringify(block) })
      }
    }
    return parts
  }
  private async run(options: GenerateOptions, signal: AbortSignal, emit: (chunk: StreamChunk) => void): Promise<void> {
    signal.throwIfAborted()
    if (options.stop?.length) throw new LlmError('Copilot ACP does not support provider stop sequences', 'INVALID_REQUEST')
    const prompt = await this.prompt(options, signal)
    signal.throwIfAborted()
    const directory = join(this.config.directory, randomUUID())
    privateDirectory(directory)
    const bridge = new WorkerMcp()
    let client: AcpClient | undefined, sessionId: string | undefined, selected: ToolCallBlock | undefined
    let closeScope = () => {}, active = true, prompting = false
    let selectedCall!: () => void
    const selection = new Promise<void>(resolve => { selectedCall = resolve })
    const blocks: { type: 'text' | 'reasoning'; text: string }[] = []
    const diagnostics = new Set<string>()
    const authorize = () => {
      signal.throwIfAborted()
      if (!active) throw new Error('Inference request has ended')
    }
    const tools: McpTool[] = (options.tools ?? []).map(tool => ({
      name: tool.name, description: tool.description, schema: z.record(z.string(), z.unknown()), inputSchema: tool.parameters,
      execute: async args => {
        authorize()
        if (!prompting || selected) throw new Error('No tool proposal is currently accepted')
        selected = { type: 'tool-call', id: ToolCallId(randomUUID()), name: tool.name, arguments: JSON.stringify(args) }
        selectedCall()
        return { execution: 'deferred_to_host', message: 'Not executed. The host must authorize and execute this proposal.' }
      },
    }))
    const cancel = () => { void client?.close(sessionId).catch(() => {}) }
    let stopped = false
    try {
      const scope = await bridge.open(randomUUID(), tools, authorize, signal); closeScope = scope.close
      const env: NodeJS.ProcessEnv = { ...process.env, COPILOT_HOME: directory, COPILOT_ALLOW_ALL: undefined }
      for (const key of Object.keys(env)) if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) delete env[key]
      client = new AcpClient({
        argv: [this.config.executable, '--acp', '--disable-builtin-mcps', '--no-custom-instructions', '--no-ask-user',
          '--disable-client-telemetry', '--sync-session=off', '--no-auto-update', '--model', options.model,
          `--available-tools=${tools.length ? tools.map(tool => `superagent-${tool.name}`).join(',') : '__no_host_tools__'}`],
        cwd: directory, env,
        permission: params => {
          try { authorize(); return prompting && !selected && params.sessionId === sessionId
            && (params.toolCall as { kind?: string })?.kind === 'other' } catch { return false }
        },
        notification: ({ method, params }) => {
          if (!active || !prompting || selected || signal.aborted || method !== 'session/update' || params.sessionId !== sessionId) return
          const update = params.update as { sessionUpdate?: string; content?: { type?: string; text?: string } } | undefined
          const type = update?.sessionUpdate === 'agent_message_chunk' ? 'text'
            : update?.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : undefined
          if (!type || update?.content?.type !== 'text' || !update.content.text) return
          // Copilot emits each allowlist diagnostic once as an unannotated assistant chunk before inference.
          const diagnostic = ['Info: Disabled tools:', ...tools.length ? [] : ['Info: Unknown tool name in the tool allowlist: "__no_host_tools__"']]
            .find(prefix => update.content!.text!.startsWith(prefix))
          if (!blocks.length && diagnostic && !diagnostics.has(diagnostic)) { diagnostics.add(diagnostic); return }
          let index = blocks.findIndex(block => block.type === type)
          if (index < 0) { index = blocks.length; blocks.push({ type, text: '' }); emit({ type: 'block-start', index, blockType: type }) }
          blocks[index]!.text += update.content.text
          emit({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: update.content.text })
        },
      })
      signal.addEventListener('abort', cancel, { once: true })
      signal.throwIfAborted()
      const init = await client.request<{ agentCapabilities?: { promptCapabilities?: { image?: boolean } } }>('initialize',
        { protocolVersion: 1, clientInfo: { name: 'dsh-copilot-model', version: '0.1.0' }, clientCapabilities: {} })
      if (prompt.some(part => part.type === 'image') && !init.agentCapabilities?.promptCapabilities?.image) {
        throw new LlmError('This Copilot CLI does not support ACP image input', 'INVALID_REQUEST')
      }
      sessionId = (await client.request<{ sessionId: string }>('session/new', { cwd: directory, mcpServers: [scope.config] })).sessionId
      signal.throwIfAborted(); prompting = true
      const response = client.request<{ stopReason: string }>('session/prompt', { sessionId, prompt }, 0)
      const result = await Promise.race([response, selection])
      prompting = false
      await client.close(sessionId); stopped = true
      signal.throwIfAborted()
      if (!selected && result?.stopReason !== 'end_turn') throw new LlmError(`Copilot stopped with ${result?.stopReason ?? 'no response'}`, 'COPILOT_STOPPED')
      for (const [index, block] of blocks.entries()) emit({ type: 'block-end', index, block })
      if (selected) {
        emit({ type: 'block-start', index: blocks.length, blockType: 'tool-call' })
        emit({ type: 'block-end', index: blocks.length, block: selected })
      } else if (!blocks.some(block => block.type === 'text' && block.text)) throw new LlmError('Copilot returned no assistant text', 'EMPTY_RESPONSE')
    } finally {
      active = false; prompting = false; closeScope()
      signal.removeEventListener('abort', cancel)
      try { await client?.close(sessionId); stopped = true } finally {
        await bridge.close()
        if (stopped) await rm(directory, { recursive: true, force: true })
      }
    }
    emit({ type: 'finish', reason: { kind: selected ? 'tool-calls' : 'stop' } })
  }
  async shutdown(): Promise<void> { this.lifetime.abort(); await Promise.all(this.jobs) }
}

export function apply(ctx: Context, config: Configuration): void {
  const adapter = new CopilotModel(config, ctx.attachments)
  ctx.effect(() => ctx.llm.registerAdapter(['copilot'], adapter))
  ctx.effect(() => () => adapter.shutdown())
}
