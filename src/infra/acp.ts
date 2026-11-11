/** A bounded JSON-RPC connection to an owned stdio ACP agent. */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { nativeCommand } from './platform.ts'

export interface AcpNotification { method: string; params: Record<string, unknown> }
export interface AcpOptions {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  notification(message: AcpNotification): void
  permission(params: Record<string, unknown>): boolean
}
/** A transport or peer JSON-RPC failure, retaining the peer's error code. */
export class AcpError extends Error {
  constructor(message: string, readonly code?: number) { super(message) }
}
/** Owns one child process, pending requests and its cancellation/EOF lifecycle. */
export class AcpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer?: NodeJS.Timeout }>()
  private sequence = 0
  private buffer = ''
  private ended = false
  private closing?: Promise<void>
  private readonly exited: Promise<void>
  constructor(private readonly options: AcpOptions) {
    const [program, ...args] = nativeCommand(options.argv)
    this.child = spawn(program!, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: 'pipe' })
    this.exited = new Promise(resolve => this.child.once('close', () => { this.ended = true; this.fail(new AcpError('ACP process exited')); resolve() }))
    this.child.on('error', error => this.fail(error))
    this.child.stdin.on('error', error => this.fail(error))
    this.child.stderr.resume()
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      if (this.buffer.length > 16 * 1024 * 1024) { this.fail(new AcpError('ACP message exceeds 16 MiB')); void this.close(); return }
      for (;;) {
        const at = this.buffer.indexOf('\n')
        if (at < 0) break
        const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1)
        if (!line.trim()) continue
        try { this.receive(JSON.parse(line) as Record<string, unknown>) }
        catch { this.fail(new AcpError('Invalid ACP message')); void this.close(); break }
      }
    })
  }
  private write(message: unknown): void {
    if (this.ended || this.child.stdin.destroyed) throw new AcpError('ACP connection is closed')
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }
  notify(method: string, params: Record<string, unknown>): void { this.write({ jsonrpc: '2.0', method, params }) }
  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeout = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id); reject(new AcpError(`${method} timed out`))
      }, timeout) : undefined
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      try { this.write({ jsonrpc: '2.0', id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  private receive(message: Record<string, unknown>): void {
    if (message.method) {
      const method = String(message.method), params = (message.params ?? {}) as Record<string, unknown>
      if (message.id !== undefined) {
        if (method === 'session/request_permission') {
          const options = params.options as { kind: string; optionId: string }[] | undefined
          const option = this.options.permission(params) && options?.find(item => item.kind === 'allow_once')
          this.write({ jsonrpc: '2.0', id: message.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } })
        } else this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method not supported' } })
      } else this.options.notification({ method, params })
      return
    }
    const pending = this.pending.get(Number(message.id))
    if (!pending) return
    clearTimeout(pending.timer); this.pending.delete(Number(message.id))
    const error = message.error as { message?: string; code?: number } | undefined
    if (error) pending.reject(new AcpError(error.message ?? 'ACP request failed', error.code))
    else pending.resolve(message.result)
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
  close(sessionId?: string): Promise<void> {
    return this.closing ??= this.stop(sessionId)
  }
  private async waitForExit(milliseconds: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds) })]) }
    finally { clearTimeout(timer) }
  }
  private async stop(sessionId?: string): Promise<void> {
    if (this.ended) return
    if (sessionId) { try { this.notify('session/cancel', { sessionId }) } catch {} }
    this.child.stdin.end()
    await this.waitForExit(10_000)
    if (!this.ended && this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => execFile('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `function Stop-OwnedTree([int]$processId) { Get-CimInstance Win32_Process -Filter "ParentProcessId = $processId" | ForEach-Object { Stop-OwnedTree $_.ProcessId }; Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }; Stop-OwnedTree ${this.child.pid}`],
        { windowsHide: true, timeout: 10_000 }, error => error ? reject(new AcpError('Could not stop the owned ACP process')) : resolve()))
      } else this.child.kill('SIGKILL')
      await this.waitForExit(5000)
    }
    if (!this.ended) throw new AcpError('ACP did not close its stdio; inspect its owned background processes before retrying')
  }
}
