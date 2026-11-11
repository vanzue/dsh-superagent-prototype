/** Isolated monitor lifecycle and read-only routes; deliberately does not instantiate the execution Runtime. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { sameOrigin } from '../app/http.ts'
import { privateDirectory } from '../infra/platform.ts'
import { MonitorGithub } from './github.ts'
import { MonitorConfig, MonitorSchedule, Snapshot, type MonitorView } from './model.ts'

export const MONITOR_MARKER = 'monitor-repository.json'

/** Serves only cached reads; every non-GET request is denied before any body is read or action is looked up. */
export function registerMonitorHttp(ctx: Context, view: () => MonitorView): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  return ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(JSON.stringify(value))
    }
    if (!sameOrigin(req, ctx.webServer.port)) { send(403, { error: 'Same-origin management request required' }); return }
    if (req.method !== 'GET') { send(403, { error: 'Read-only monitor: execution and mutations are disabled' }); return }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/orchestrator/api/mode') { send(200, { mode: 'monitor' }); return }
    if (path === '/orchestrator/api/monitor') { send(200, view()); return }
    if (path === '/orchestrator/api/state') {
      const status = view()
      send(200, { mode: 'monitor', paused: true, load: { running: 0, queued: 0, maxWorkers: 0 },
        setup: { problem: null, accounts: { repository: status.repository, agent: 'anonymous', feishu: null } },
        health: { runtime: { state: 'ready', detail: 'Read-only monitor; no agents or outbound actions' },
          github: { state: status.error ? 'error' : status.snapshot ? 'ready' : 'starting', detail: status.error ?? 'Anonymous public REST reads only' } } })
      return
    }
    send(404, { error: 'Unknown monitoring operation' })
  } })
}

/** Owns a repository-bound snapshot and timer, with no Engine, sessions, tools, subprocesses or outbox. */
export class MonitorRuntime {
  private readonly config: ReturnType<typeof MonitorConfig.parse>
  private readonly reader: MonitorGithub
  private readonly abort = new AbortController()
  private readonly release: () => void
  private readonly unregister: () => void
  private timer?: ReturnType<typeof setTimeout>
  private current?: Promise<void>
  private status: MonitorView
  private readonly snapshotFile: string
  private readonly scheduleFile: string
  constructor(ctx: Context, stateDir: string, config: unknown, transport?: typeof fetch) {
    this.config = MonitorConfig.parse(config)
    privateDirectory(stateDir)
    this.release = lockSync(stateDir, { stale: 30_000, onCompromised: () => {
      this.abort.abort(); clearTimeout(this.timer); this.status = { ...this.status, error: 'Monitor state lock lost; collection stopped' }
    } })
    try {
      if (existsSync(join(stateDir, 'orchestrator.sqlite'))) throw new Error('Monitoring requires a fresh stateDir, not an execution database')
      const marker = join(stateDir, MONITOR_MARKER)
      if (existsSync(marker)) {
        const saved = MonitorConfig.parse(JSON.parse(readFileSync(marker, 'utf8')))
        if (saved.repository.toLowerCase() !== this.config.repository.toLowerCase()) throw new Error('A different repository requires a fresh monitor stateDir')
      } else writeFileSync(marker, JSON.stringify(this.config), { mode: 0o600, flag: 'wx' })
      this.reader = new MonitorGithub(this.config.repository, transport)
      this.snapshotFile = join(stateDir, 'monitor-snapshot.json')
      this.scheduleFile = join(stateDir, 'monitor-schedule.json')
      const snapshot = existsSync(this.snapshotFile) ? Snapshot.parse(JSON.parse(readFileSync(this.snapshotFile, 'utf8'))) : undefined
      if (snapshot && snapshot.repository !== this.config.repository) throw new Error('Snapshot repository does not match monitor')
      const schedule = existsSync(this.scheduleFile) ? MonitorSchedule.parse(JSON.parse(readFileSync(this.scheduleFile, 'utf8'))) : undefined
      if (schedule && schedule.repository !== this.config.repository) throw new Error('Schedule repository does not match monitor')
      this.reader.remaining = schedule?.remaining
      this.reader.resetAt = schedule?.resetAt
      this.reader.retryAt = schedule?.retryAt ?? 0
      this.status = { mode: 'monitor', ...this.config, refreshing: false, ...schedule, ...snapshot ? { snapshot } : {} }
      this.unregister = registerMonitorHttp(ctx, () => this.view())
      // Reopening the panel or restarting the process must not force another GitHub refresh.
      const delay = Math.max(0, (schedule ? Date.parse(schedule.nextSync) : snapshot
        ? Date.parse(snapshot.syncedAt) + this.config.pollSeconds * 1000 : 0) - Date.now())
      this.status.nextSync = new Date(Date.now() + delay).toISOString()
      this.timer = setTimeout(() => { this.current = this.refresh() }, delay)
    } catch (error) { this.release(); throw error }
  }
  view(): MonitorView { return this.status }
  private async refresh(): Promise<void> {
    if (this.abort.signal.aborted) return
    this.status = { ...this.status, refreshing: true, lastAttempt: new Date().toISOString() }
    const before = this.reader.requests
    try {
      const snapshot = await this.reader.snapshot(this.abort.signal)
      this.abort.signal.throwIfAborted()
      writeFileSync(`${this.snapshotFile}.tmp`, JSON.stringify(snapshot), { mode: 0o600 })
      renameSync(`${this.snapshotFile}.tmp`, this.snapshotFile)
      this.status = { ...this.status, snapshot, error: undefined }
    } catch (error) {
      if (!this.abort.signal.aborted) this.status = { ...this.status, error: error instanceof Error ? error.message : String(error) }
    } finally {
      const calls = this.reader.requests - before
      const budgetDelay = this.reader.remaining !== undefined && this.reader.remaining < calls + 5 && this.reader.resetAt
        ? Date.parse(this.reader.resetAt) + 2000 : 0
      const next = Math.max(Date.now() + this.config.pollSeconds * 1000, this.reader.retryAt, budgetDelay)
      this.status = { ...this.status, refreshing: false, remaining: this.reader.remaining, resetAt: this.reader.resetAt,
        nextSync: new Date(next).toISOString() }
      if (!this.abort.signal.aborted) {
        try {
          writeFileSync(`${this.scheduleFile}.tmp`, JSON.stringify({ ...this.status, snapshot: undefined, retryAt: this.reader.retryAt }), { mode: 0o600 })
          renameSync(`${this.scheduleFile}.tmp`, this.scheduleFile)
        } catch { this.status = { ...this.status, error: 'Cannot persist monitoring schedule' } }
      }
      if (!this.abort.signal.aborted) this.timer = setTimeout(() => { this.current = this.refresh() }, next - Date.now())
    }
  }
  async stop(): Promise<void> {
    this.abort.abort()
    clearTimeout(this.timer)
    await this.current
    this.unregister()
    this.release()
  }
}
