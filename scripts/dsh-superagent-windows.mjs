#!/usr/bin/env node
/** Native Windows controller. A private named pipe requests DSH's graceful shutdown; no PID is force-killed. */
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { lockSync } from 'proper-lockfile'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch { return false } }
const read = file => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } }

export function options(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    profile: { type: 'string', default: process.env.DSH_SUPERAGENT_PROFILE || 'superagent' },
    url: { type: 'string' }, dsh: { type: 'string' },
    timeout: { type: 'string', default: '60' }, 'stop-timeout': { type: 'string', default: '300' },
    'respect-stop': { type: 'boolean', default: false },
  } })
  const action = positionals[0]
  if (positionals.length !== 1 || !['start', 'stop', 'restart', 'status', '_serve'].includes(action)) {
    throw new Error('Usage: node scripts\\dsh-superagent-windows.mjs start|stop|restart|status [--profile name] [--url http://127.0.0.1:3082] [--dsh path-to-dsh-lib-bin.js]')
  }
  if (!/^[a-z0-9_][a-z0-9_.-]*$/i.test(values.profile)) throw new Error('Invalid profile name')
  const timeout = Number(values.timeout), stopTimeout = Number(values['stop-timeout'])
  if (![timeout, stopTimeout].every(n => Number.isFinite(n) && n > 0)) throw new Error('Timeouts must be positive')
  const directory = join(root, '.artifacts', 'control', 'profiles', values.profile)
  const file = join(directory, 'windows-service.json')
  const saved = read(file)
  const url = new URL(values.url || process.env.DSH_SUPERAGENT_URL || saved?.url || 'http://127.0.0.1:3082')
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTP loopback root URL')
  }
  return { action, profile: values.profile, directory, file, url: url.origin, timeout, stopTimeout,
    home: process.env.DSH_HOME ?? saved?.home ?? '',
    respectStop: values['respect-stop'], dsh: values.dsh || saved?.dsh,
    pipe: `\\\\.\\pipe\\dsh-superagent-${createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0, 24)}` }
}

function protect(directory) {
  mkdirSync(directory, { recursive: true })
  const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const sid = execFileSync(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-\d+(?:-\d+)+/)?.[0]
  if (!sid) throw new Error('Cannot determine the Windows account SID')
  execFileSync(join(system, 'icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
    { windowsHide: true, stdio: 'pipe' })
}

async function health(url) {
  try {
    const response = await fetch(`${url}/orchestrator/api/state`, { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(2000) })
    return response.ok ? await response.json() : undefined
  } catch { return undefined }
}

export function outcome(state) {
  if (state?.setup?.problem) return 3
  if (!state || !['ready', 'paused'].includes(state.health?.runtime?.state)) return 1
  return Object.values(state.health).some(entry => entry.state === 'error') ? 2 : 0
}

function request(config, record, action) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(config.pipe)
    let text = ''
    socket.setEncoding('utf8')
    socket.setTimeout(3000, () => socket.destroy(new Error('Service control timed out')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ token: record.token, action }) + '\n'))
    socket.on('data', chunk => {
      text += chunk
      if (text.length > 4096) socket.destroy(new Error('Invalid service response'))
      else if (text.includes('\n')) {
        socket.end()
        try {
          const value = JSON.parse(text.split('\n')[0])
          if (value.pid !== record.pid || value.error) reject(new Error(value.error || 'Service identity changed'))
          else resolve(value)
        } catch (error) { reject(error) }
      }
    })
    socket.on('end', () => { if (!text.includes('\n')) reject(new Error('Service disconnected before replying')) })
  })
}

async function status(config) {
  const record = read(config.file)
  let connected = false
  if (record) {
    try { await request(config, record, 'status'); connected = true }
    catch (error) { if (alive(record.pid)) throw error }
  }
  const state = connected ? await health(config.url) : undefined
  console.log(JSON.stringify({ pids: connected ? [record.pid] : [], url: config.url,
    manually_stopped: existsSync(join(config.directory, 'manually-stopped')),
    health: state?.health, setup: state?.setup?.problem ?? null, log: record?.log }, null, 2))
  return connected ? outcome(state) : 1
}

async function stop(config, intentional = true) {
  if (intentional) writeFileSync(join(config.directory, 'manually-stopped'), new Date().toISOString())
  const record = read(config.file)
  if (!record) {
    if (await health(config.url)) throw new Error('An unmanaged service answers at this URL; refusing to stop it')
    return
  }
  try { await request(config, record, 'stop') }
  catch (error) { if (alive(record.pid)) throw error }
  const deadline = Date.now() + config.stopTimeout * 1000
  while (alive(record.pid)) {
    if (Date.now() >= deadline) throw new Error('Graceful stop timed out; no forced kill was sent')
    await sleep(250)
  }
  if (read(config.file)?.token === record.token) writeFileSync(config.file, JSON.stringify({ ...record, pid: 0 }), { mode: 0o600 })
  console.log('dsh-superagent stopped.')
}

function locateDsh(config) {
  const candidates = config.dsh ? [resolve(config.dsh)] : (process.env.PATH || '').split(delimiter)
    .map(dir => join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  const file = candidates.find(existsSync)
  if (!file) throw new Error('Install @deepseek-ai/dsh globally or pass --dsh with its lib\\bin.js path')
  return file
}

async function start(config) {
  const old = read(config.file)
  if (old && alive(old.pid)) {
    await request(config, old, 'status')
    try { unlinkSync(join(config.directory, 'manually-stopped')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    return status(config)
  }
  if (await health(config.url)) throw new Error('An existing orchestrator answers at this URL; refusing duplicate startup')
  const dsh = locateDsh(config)
  const log = join(config.directory, `windows-${Date.now()}.log`)
  const output = openSync(log, 'a', 0o600)
  const record = { token: randomBytes(32).toString('hex'), pid: 0, url: config.url, dsh, log, home: config.home }
  writeFileSync(config.file, JSON.stringify(record), { mode: 0o600 })
  const child = spawn(process.execPath, [script, '_serve', '--profile', config.profile], {
    cwd: root, detached: true, windowsHide: true, stdio: ['ignore', output, output],
  })
  closeSync(output)
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref()
  try { unlinkSync(join(config.directory, 'manually-stopped')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  console.log(`Log: ${log}`)
  const deadline = Date.now() + config.timeout * 1000
  while (Date.now() < deadline) {
    const current = read(config.file)
    if (!alive(child.pid)) throw new Error(`Service exited; inspect ${log}`)
    const state = current?.pid ? await health(config.url) : undefined
    if (state?.setup?.problem || ['ready', 'paused', 'error'].includes(state?.health?.runtime?.state)) return status(config)
    await sleep(500)
  }
  throw new Error(`Startup timed out; the owned process was left available for status/stop. Inspect ${log}`)
}

async function serve(config) {
  const record = read(config.file)
  if (!record || record.pid) throw new Error('Invalid startup record')
  record.pid = process.pid
  writeFileSync(config.file, JSON.stringify(record), { mode: 0o600 })
  if (record.home) process.env.DSH_HOME = record.home
  let stopping = false
  const server = createServer(socket => {
    let text = ''
    socket.setEncoding('utf8')
    socket.setTimeout(3000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', chunk => {
      text += chunk
      if (text.length > 2048) return socket.destroy()
      if (!text.includes('\n')) return
      let value
      try { value = JSON.parse(text.split('\n')[0]) } catch { return socket.destroy() }
      const token = Buffer.from(typeof value.token === 'string' ? value.token : '')
      const expected = Buffer.from(record.token)
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) return socket.destroy()
      if (value.action === 'stop' && !stopping) {
        if (!process.listenerCount('SIGTERM')) return socket.end(JSON.stringify({ pid: process.pid, error: 'DSH is still starting' }) + '\n')
        stopping = true
        socket.end(JSON.stringify({ pid: process.pid }) + '\n')
        server.close()
        setImmediate(() => process.emit('SIGTERM'))
      } else socket.end(JSON.stringify({ pid: process.pid }) + '\n')
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.pipe, resolve) })
  server.unref()
  const { runCli } = await import(pathToFileURL(record.dsh).href)
  const url = new URL(record.url)
  process.argv = [process.execPath, record.dsh, '--profile', config.profile, '--no-open', '--host',
    url.hostname === 'localhost' ? '127.0.0.1' : url.hostname, '--port', url.port || '80']
  await runCli()
}

export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'win32') throw new Error('Use scripts/dsh-superagent on Unix')
  const config = options(argv)
  if (config.action === '_serve') { await serve(config); return 0 }
  protect(config.directory)
  const release = lockSync(config.directory, { stale: 30_000 })
  try {
    if (config.respectStop && ['start', 'restart'].includes(config.action) && existsSync(join(config.directory, 'manually-stopped'))) {
      console.log('Intentional stop is active; automatic recovery skipped.')
      return 0
    }
    if (config.action === 'status') return await status(config)
    if (config.action === 'stop' || config.action === 'restart') await stop(config, config.action === 'stop')
    return config.action === 'stop' ? 0 : await start(config)
  } finally { release() }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  main().then(code => { process.exitCode = code }, error => { console.error(error.message); process.exitCode = 1 })
}
