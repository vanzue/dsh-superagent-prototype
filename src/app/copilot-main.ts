/** A serial, durable Copilot ACP orchestrator with only framework-owned MCP tools. */
import { appendFileSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { key } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Settings } from '../policy.ts'
import { AcpClient } from '../infra/acp.ts'
import { WorkerMcp } from '../infra/worker-mcp.ts'
import { agentVariables, workerBin, withoutDirectory } from '../infra/environment.ts'
import { privateDirectory } from '../infra/platform.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { WorkerTranscriptEntry } from '../executor/copilot.ts'
import { Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'
import type { Tool } from './tools/tool.ts'

export interface CopilotMainState {
  config: Settings['eval']['copilot']
  sessionId?: string
  seeded?: boolean
  inFlight?: string
  uncertain?: boolean
  error?: string
  recovery?: boolean
}
export interface MainSession {
  holds(requestId: string): boolean
  prompt(requestId: string, text: string): Promise<void>
  inject(name: string, text: string): void
}
interface Host {
  store: Pick<Store, 'get' | 'set' | 'keys' | 'atomic' | 'settings'>
  effects: Pick<Effects, 'handle' | 'enqueue' | 'pending' | 'cancel' | 'kick'>
  health: HealthEntry
  masterId: string
  directory: string
  lifetime: AbortSignal
  paused(): boolean
  tools(authorize: () => void): Tool[]
  prompt(): { revision: number; text: string }
}

/** Owns ACP turns, durable delivery receipts, scoped capabilities and explicit recovery of uncertain sends. */
export class CopilotMain implements MainSession {
  private readonly config: Settings['eval']['copilot']
  private bridge?: WorkerMcp
  private active?: { client: AcpClient; abort: AbortController }
  private readonly directory: string
  constructor(private readonly host: Host) {
    this.config = { ...host.store.settings().eval.copilot }
    this.directory = join(host.directory, 'copilot-main')
    host.effects.handle('main-turn', ({ text }, id) => this.run(id, text), {
      ordered: true, limit: () => host.paused() || this.state()?.uncertain ? 0 : 1,
    })
  }
  private state(): CopilotMainState | undefined { return this.host.store.get(KV.copilotMain.state) }
  private save(state: CopilotMainState): void { this.host.store.set(KV.copilotMain.state, { ...state }) }
  holds(id: string): boolean {
    const receipt = this.host.store.get(KV.copilotMain.receipt(key(id)))
    return receipt === 'delivered' || receipt === 'done'
  }
  async prompt(id: string, text: string): Promise<void> {
    this.host.lifetime.throwIfAborted()
    if (this.holds(id)) return
    if (!this.host.effects.pending('main-turn', id)) this.host.effects.enqueue('main-turn', id, { text })
    // Let the caller retry its delivery check, rather than starting its Eval timeout while this turn is still queued.
    throw new Later('Waiting for the Copilot orchestrator to receive this message')
  }
  inject(name: string, text: string): void { this.host.store.set(KV.copilotMain.notice(name), text) }
  resume(): void {
    const state = this.state()
    if (state?.inFlight) {
      state.uncertain = true
      state.error = 'The previous orchestrator turn was interrupted. Inspect its transcript and recorded decisions, then recover in the panel; it will not be replayed automatically.'
      this.host.store.set(KV.copilotMain.receipt(key(state.inFlight)), 'uncertain')
      this.save(state)
    }
    this.health()
  }
  status() {
    const state = this.state()
    return { backend: 'copilot' as const, sessionId: state?.sessionId, running: !!this.active,
      pending: this.host.effects.pending('main-turn'), uncertain: !!state?.uncertain, error: state?.error }
  }
  recover(): void {
    if (this.active) throw new Error('Wait for the current orchestrator process to stop')
    const state = this.state()
    if (!state?.uncertain) return
    this.host.store.atomic(() => {
      if (state.inFlight) {
        this.host.effects.cancel('main-turn', state.inFlight)
        this.host.store.set(KV.copilotMain.receipt(key(state.inFlight)), 'done')
      }
      delete state.inFlight; delete state.error
      state.uncertain = false; state.recovery = true
      this.save(state)
    })
    this.health(); this.host.effects.kick()
  }
  transcript(): WorkerTranscriptEntry[] {
    try { return readFileSync(join(this.directory, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as WorkerTranscriptEntry) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  private record(role: string, text: string): void {
    appendFileSync(join(this.directory, 'transcript.jsonl'), JSON.stringify({
      type: role === 'tool' ? 'tool/result' : `${role}/message`, message: { role, content: [{ type: 'text', text }] },
    }) + '\n')
  }
  private health(): void {
    const state = this.state()
    this.host.health.set({ state: state?.error ? 'error' : 'ready',
      detail: state?.error ?? (this.active ? 'Copilot orchestrator is processing a message' : 'Copilot orchestrator is idle; no DSH model calls') })
  }
  private async run(id: string, message: string): Promise<void> {
    if (this.host.store.get(KV.copilotMain.receipt(key(id))) === 'done') return
    if (this.host.paused() || this.state()?.uncertain) throw new Later('Orchestrator is paused or needs recovery')
    if (!this.config.executable) throw new Error('Configure the Copilot orchestrator executable in Eval settings')
    privateDirectory(this.directory)
    const home = join(this.config.home || join(this.host.directory, 'copilot'), 'orchestrator')
    privateDirectory(home)
    const abort = new AbortController(), signal = AbortSignal.any([this.host.lifetime, abort.signal])
    let active = true
    const authorize = () => {
      signal.throwIfAborted()
      if (!active || this.host.paused() || JSON.stringify(this.host.store.settings().eval.copilot) !== JSON.stringify(this.config)
        || this.host.store.settings().eval.backend !== 'copilot') throw new Error('Orchestrator authorization is no longer active')
    }
    let state = this.state() ?? { config: this.config }
    if (JSON.stringify(state.config) !== JSON.stringify(this.config)) state = { config: this.config, recovery: true }
    let recording = false, sessionId: string | undefined
    const received = () => {
      if (recording && this.host.store.get(KV.copilotMain.receipt(key(id))) === 'sending') {
        this.host.store.set(KV.copilotMain.receipt(key(id)), 'delivered')
      }
    }
    const toolAuthorization = () => { authorize(); if (!recording) throw new Error('No orchestrator turn is active') }
    const tools = this.host.tools(toolAuthorization).map(tool => ({ ...tool,
      execute: async (args: unknown, signal: AbortSignal) => {
        toolAuthorization(); received(); return tool.execute(args, signal)
      } }))
    const scope = await (this.bridge ??= new WorkerMcp()).open(key(this.host.masterId, id), tools, authorize, signal)
    const env: NodeJS.ProcessEnv = { ...process.env, ...agentVariables(this.host.directory), COPILOT_HOME: home, COPILOT_ALLOW_ALL: undefined }
    for (const name of Object.keys(env)) if (/KEY|PASSWORD|SECRET|TOKEN/i.test(name)) delete env[name]
    const path = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
    env[path] = [workerBin(this.host.directory), withoutDirectory(env[path] ?? '', workerBin(this.host.directory))].join(delimiter)
    let client: AcpClient | undefined
    const cancel = () => { void client?.close(sessionId).catch(error => this.host.health.set({ state: 'error', detail: String(error) })) }
    try {
      authorize()
      client = new AcpClient({
        argv: [this.config.executable, '--acp', '--disable-builtin-mcps', '--no-custom-instructions', '--no-ask-user',
          '--disable-client-telemetry', '--sync-session=off', '--no-auto-update', '--model', this.config.model,
          `--available-tools=${tools.map(tool => `superagent-${tool.name}`).join(',')}`],
        cwd: this.directory, env,
        permission: params => {
          try { authorize(); return recording && params.sessionId === sessionId && (params.toolCall as { kind?: string })?.kind === 'other' }
          catch { return false }
        },
        notification: ({ method, params }) => {
          if (!recording || method !== 'session/update' || params.sessionId !== sessionId) return
          const update = params.update as { sessionUpdate?: string; content?: { type?: string; text?: string } } | undefined
          if (['agent_message_chunk', 'tool_call', 'user_message_chunk'].includes(update?.sessionUpdate ?? '')) received()
          if (update?.sessionUpdate === 'agent_message_chunk') this.record('assistant', update.content?.text ?? '')
          else if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') this.record('tool', JSON.stringify(update))
        },
      })
      this.active = { client, abort }; this.health()
      signal.addEventListener('abort', cancel, { once: true })
      const init = await client.request<{ agentCapabilities?: { loadSession?: boolean } }>('initialize',
        { protocolVersion: 1, clientInfo: { name: 'dsh-superagent-orchestrator', version: '0.1.0' }, clientCapabilities: {} })
      const parameters = { cwd: this.directory, mcpServers: [scope.config] }
      if (state.sessionId && state.seeded) {
        if (!init.agentCapabilities?.loadSession) throw new Error('Copilot does not support session recovery')
        await client.request('session/load', { ...parameters, sessionId: state.sessionId })
      } else {
        state.sessionId = (await client.request<{ sessionId: string }>('session/new', parameters)).sessionId
      }
      sessionId = state.sessionId
      const policy = this.host.prompt()
      const notices = this.host.store.keys(KV.copilotMain.notice).map(name => this.host.store.get(name))
      const prompt = `[Superagent orchestrator instructions, revision ${policy.revision}]\n${policy.text}\n`
        + 'You are the orchestrator, not a worker. Use only the superagent MCP tools to read context, route candidates and reply. '
        + 'Do not execute the task yourself, launch processes, poll workers, or modify configuration. Operational skills are embedded here, not separate tools. '
        + 'End the turn after routing or replying; worker reports and new human requests arrive as later messages. '
        + 'A tool error or an unavailable image is not evidence: do not guess. Plain assistant text is not posted to GitHub.\n'
        + (state.recovery ? 'Recovery: inspect recorded tickets, decisions and replies before acting. The interrupted request was not replayed; never duplicate an operation already recorded.\n' : '')
        + `Configuration notices (context only, not new tasks): ${JSON.stringify(notices)}\nIncoming event:\n${message}`
      authorize()
      this.host.store.atomic(() => {
        state.inFlight = id; delete state.error; this.save(state)
        this.host.store.set(KV.copilotMain.receipt(key(id)), 'sending')
        const revisions = this.host.store.get(KV.sessions.prompts(this.host.masterId)) ?? []
        if (revisions.at(-1) !== policy.revision) this.host.store.set(KV.sessions.prompts(this.host.masterId), [...revisions, policy.revision])
      })
      this.record('user', prompt); recording = true
      const result = await client.request<{ stopReason: string }>('session/prompt',
        { sessionId, prompt: [{ type: 'text', text: prompt }] }, 0)
      if (result.stopReason !== 'end_turn') throw new Error(`Copilot orchestrator stopped with ${result.stopReason}`)
      this.host.store.atomic(() => {
        this.host.store.set(KV.copilotMain.receipt(key(id)), 'done')
        delete state.inFlight; state.seeded = true; state.recovery = false; state.uncertain = false
        this.save(state)
      })
    } catch (error) {
      state.error = String(error)
      if (state.inFlight) {
        state.uncertain = true
        this.host.store.set(KV.copilotMain.receipt(key(id)), 'uncertain')
      }
      this.save(state); throw error
    } finally {
      active = false; recording = false; abort.abort(); scope.close()
      signal.removeEventListener('abort', cancel)
      try { await client?.close(sessionId); this.active = undefined }
      catch (error) { state.error = String(error); state.uncertain = true; this.save(state); throw error }
      finally { this.health() }
    }
  }
  async shutdown(): Promise<void> {
    this.active?.abort.abort()
    await this.active?.client.close(this.state()?.sessionId)
    await this.bridge?.close()
  }
}
