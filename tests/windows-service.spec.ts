import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const script = resolve('scripts', 'dsh-superagent-windows.mjs')

it.runIf(process.platform === 'win32')('manages only its owned Windows service, with graceful stop, restart and a per-profile stop marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'superagent service '))
  const profile = `test-native-${process.pid}-${Date.now()}`
  const control = resolve('.artifacts', 'control', 'profiles', profile)
  const listener = createServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  const module = join(dir, 'fake-dsh.mjs')
  const stopped = join(dir, 'stopped')
  writeFileSync(module, `import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs';
export async function runCli() {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  const server = createServer((req,res) => {
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({health:{runtime:{state:'ready'}},setup:{problem:null}}));
  });
  server.listen(port,'127.0.0.1');
  process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(stopped)}, 'graceful'); server.close(() => process.exit(0)); });
}`)
  const run = (action: string, ...args: string[]) => exec(process.execPath, [script, action, '--profile', profile,
    '--url', `http://127.0.0.1:${port}`, '--dsh', module, '--timeout', '15', '--stop-timeout', '15', ...args],
  { timeout: 25_000, env: { ...process.env, DSH_HOME: join(dir, 'home') } })
  try {
    await run('start')
    const first = JSON.parse((await run('status')).stdout)
    expect(first.pids).toHaveLength(1)
    await run('start')
    expect(JSON.parse((await run('status')).stdout).pids).toEqual(first.pids)
    await run('restart')
    const second = JSON.parse((await run('status')).stdout)
    expect(second.pids[0]).not.toBe(first.pids[0])
    await run('stop')
    expect((await run('start', '--respect-stop')).stdout).toContain('Intentional stop')
    const status = await run('status').catch(error => ({ stdout: error.stdout }))
    expect(JSON.parse(status.stdout)).toMatchObject({ pids: [], manually_stopped: true })
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(stopped, 'utf8')).toBe('graceful')
  } finally {
    await run('stop')
    rmSync(control, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}, 90_000)

it.runIf(process.platform === 'win32')('refuses non-loopback control URLs before creating a service', async () => {
  await expect(exec(process.execPath, [script, 'start', '--url', 'http://example.invalid:3082']))
    .rejects.toMatchObject({ stderr: expect.stringContaining('HTTP loopback root URL') })
})
