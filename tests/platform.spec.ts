import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { Config, executable, resolveDeployment, workerProbe } from '../src/deployment.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { ABSOLUTE_PATH, nativeCommand, powershellQuote, prepareCommand } from '../src/infra/platform.ts'
import { runAsWorker } from '../src/infra/environment.ts'
import { testMachine } from './fixtures/deployment.ts'

const exec = promisify(execFile)
const directories: string[] = []
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), 'superagent platform ')); directories.push(dir); return dir }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('accepts drive, UNC and POSIX absolute directories, but rejects drive-relative paths', () => {
  for (const path of ['C:\\agent state', 'D:/agent/work', '\\\\server\\share\\work', '/srv/agent']) {
    expect(ABSOLUTE_PATH.test(path)).toBe(true)
    expect(() => Config({ stateDir: path })).not.toThrow()
    expect(ExecutorConfigSchema.safeParse({ directory: path }).success).toBe(true)
  }
  for (const path of ['C:work', 'relative\\work', '~\\work', '\\work', '\\\\server']) {
    expect(() => Config({ stateDir: path })).toThrow()
    expect(ExecutorConfigSchema.safeParse({ directory: path }).success).toBe(false)
  }
})

/** Real subprocesses, without model or GitHub network access. */
const subprocess = { spawn: (spec: { argv: string[]; cwd: string; env?: Record<string, string> }) => {
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, windowsHide: true })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', chunk => { output.stdout += String(chunk) })
  child.stderr.on('data', chunk => { output.stderr += String(chunk) })
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', exitCode => resolve({ exitCode }))
  })
  const reader = (key: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[key], nextOffset: 0, lossy: false }) })
  return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
} } as unknown as SubprocessRuntime

describe.runIf(process.platform === 'win32')('native Windows execution', () => {
  it('finds executable extensions and rejects relative paths with backslashes', () => {
    expect(executable('gh', process.env.PATH ?? '')).toMatch(/gh\.exe$/i)
    expect(executable('gh.exe', process.env.PATH ?? '')).toMatch(/gh\.exe$/i)
    expect(() => executable('relative\\gh', process.env.PATH ?? '')).toThrow('absolute path')
    expect(() => nativeCommand(['script.cmd', '& unexpected'])).toThrow('.exe or .ps1')
  })
  it('checks a PowerShell account wrapper without invoking env or sh', async () => {
    const dir = temporary(), cli = join(dir, "agent's cli.ps1")
    writeFileSync(cli, `if ($args[1] -eq 'user') { '{"login":"fixture-bot","id":7}' } else { '{"name":"example/fixture","push":true}' }\n`)
    const machine = testMachine({ stateDir: dir })
    const deployment = await resolveDeployment(machine, { repository: 'example/fixture', cli },
      workerProbe(subprocess, dir, dir, new AbortController().signal))
    expect(deployment.github.login).toBe('fixture-bot')
    expect(deployment.github.cli).toBe(cli)
  })
  it('passes prepare environment variables and reports a native command failure', async () => {
    const dir = temporary(), signal = new AbortController().signal
    const result = await runAsWorker(subprocess, prepareCommand('[Console]::Write($env:DSH_SUPERAGENT_DIR)'), dir, signal, { DSH_SUPERAGENT_DIR: dir })
    expect(result).toBe(dir)
    await expect(runAsWorker(subprocess, prepareCommand(`& ${powershellQuote(process.execPath)} -e 'process.exit(7)'`), dir, signal))
      .rejects.toThrow()
  })
  it('creates a Git worktree in a directory with spaces using PowerShell preparation', async () => {
    const dir = temporary(), repository = join(dir, 'clone'), worktree = join(dir, 'worker space')
    await exec('git', ['clone', '--quiet', '--shared', '--no-checkout', process.cwd(), repository])
    await runAsWorker(subprocess, prepareCommand(`git -C ${powershellQuote(repository)} worktree add --detach $env:DSH_SUPERAGENT_DIR HEAD`),
      dir, new AbortController().signal, { DSH_SUPERAGENT_DIR: worktree })
    expect((await exec('git', ['-C', worktree, 'status', '--porcelain'])).stdout).toBe('')
    await exec('git', ['-C', repository, 'worktree', 'remove', worktree])
  })
})
