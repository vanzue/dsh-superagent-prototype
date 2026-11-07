/** Native paths and process arguments shared by setup, host commands and workers. */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const ABSOLUTE_PATH = /^(?:\/|[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))/i
export const powershellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`

/** Invoke PowerShell scripts without passing untrusted arguments through a shell command string. */
export function nativeCommand(argv: readonly string[]): string[] {
  if (process.platform !== 'win32') return [...argv]
  if (/\.ps1$/i.test(argv[0] ?? '')) {
    return ['pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...argv]
  }
  if (/\.(cmd|bat)$/i.test(argv[0] ?? '')) throw new Error('Use an .exe or .ps1 CLI on Windows, not a .cmd or .bat wrapper')
  return [...argv]
}

/** Custom prepare commands use the native shell; failed native commands must fail the preparation. */
export function prepareCommand(command: string): string[] {
  return process.platform === 'win32'
    ? ['pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $true; & {\n${command}\n}; if (-not $?) { exit 1 }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`]
    : ['sh', '-c', command]
}

let sid: string | undefined
const protectedDirectories = new Set<string>()
/** Restrict state directories using native ACLs rather than ineffective Windows chmod bits. */
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32' || protectedDirectories.has(path)) return
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  sid ??= execFileSync(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
    .match(/S-1-\d+(?:-\d+)+/)?.[0]
  if (!sid) throw new Error('Cannot determine the Windows account SID for state directory permissions')
  execFileSync(join(system, 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
    { windowsHide: true, stdio: 'pipe' })
  protectedDirectories.add(path)
}
