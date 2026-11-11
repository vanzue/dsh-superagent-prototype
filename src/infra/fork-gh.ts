/** Default-path GitHub CLI guard for a fork workflow; not an OS or credential-level sandbox. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { MUTATIONS, NODE_OWNERS, REPOSITORY, repositoryName } from '../mirror/github.ts'
import { nativeCommand } from './platform.ts'
import { commandError } from './commands.ts'

const exec = promisify(execFile)
const Configuration = z.object({ fork: z.string(), upstream: z.string(), cli: z.string() })
export type ForkGuardConfig = z.infer<typeof Configuration>
type GraphCall = (query: string, variables: Record<string, unknown>) => Promise<Record<string, any>>
function failure(): never { throw new Error('GitHub operation denied by the fork-only CLI policy') }

/** Validate GraphQL mutation templates and independently resolve every target against the fork before forwarding. */
export async function guardGraph(query: string, variables: Record<string, unknown>, fork: string, read: GraphCall): Promise<void> {
  if (!/\b(?:mutation|subscription)\b/.test(query) && /^\s*(?:query\b|\{)/.test(query)) return
  const operation = Object.entries(MUTATIONS).find(([, text]) => text === query)?.[0]
  if (!operation) failure()
  if (operation === 'createDiscussion') {
    const [owner, name] = fork.split('/')
    const value = await read(REPOSITORY, { owner, name })
    if (value.repository?.nameWithOwner.toLowerCase() !== fork.toLowerCase()
      || value.repository.id !== variables.repo || !value.repository.discussionCategories.nodes.some((item: { id: string }) => item.id === variables.category)) failure()
    return
  }
  const ids = [variables.id, variables.parent].filter(value => value !== undefined && value !== null)
  if (!ids.length || ids.some(value => typeof value !== 'string')) failure()
  const value = await read(NODE_OWNERS, { ids })
  if (!Array.isArray(value.nodes) || value.nodes.length !== ids.length) failure()
  for (const node of value.nodes) {
    const repository = node?.repository?.nameWithOwner ?? node?.discussion?.repository?.nameWithOwner
    if (typeof repository !== 'string' || repository.toLowerCase() !== fork.toLowerCase()) failure()
  }
}

/** Returns safe CLI arguments, forcing issue/PR/run operations to the fork and rejecting unscoped write commands. */
export async function guardArguments(config: ForkGuardConfig, args: string[], read: GraphCall): Promise<string[]> {
  const fork = repositoryName(config.fork), upstream = repositoryName(config.upstream)
  if (fork.toLowerCase() === upstream.toLowerCase()) failure()
  if (args[0] === 'api') {
    let path = '', method = '', input: string | undefined
    const fields: Record<string, unknown> = {}
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!
      if (['--method', '-X', '--input', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--jq', '-q', '--cache'].includes(arg)) {
        const value = args[++i]; if (value === undefined) failure()
        if (arg === '--method' || arg === '-X') { if (method) failure(); method = value.toUpperCase() }
        else if (arg === '--input') { if (input || value === '-') failure(); input = value }
        else if (arg === '-H' || arg === '--header') { if (!/^(Accept|If-None-Match|If-Modified-Since):/i.test(value)) failure() }
        else if (['-f', '--raw-field', '-F', '--field'].includes(arg)) {
          const at = value.indexOf('='), key = value.slice(0, at), field = value.slice(at + 1)
          if (at < 1 || key in fields || field.startsWith('@') || key.includes('[')) failure()
          fields[key] = arg === '-F' || arg === '--field' ? /^-?\d+$/.test(field) ? Number(field) : field : field
        }
      } else if (['--paginate', '--slurp', '--include', '-i', '--silent'].includes(arg)) continue
      else if (arg.startsWith('-') || path) failure()
      else path = arg.replace(/^\//, '')
    }
    if (!path || /[\\#%]|(^|\/)\.\.?($|\/)/.test(path.split('?')[0]!)) failure()
    let body: Record<string, unknown> = fields
    if (input) {
      if (Object.keys(fields).length) failure()
      body = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(input, 'utf8')))
    }
    if (path === 'graphql') {
      const query = body.query
      if (typeof query !== 'string') failure()
      const variables = input ? z.record(z.string(), z.unknown()).parse(body.variables ?? {})
        : Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'query'))
      await guardGraph(query, variables, fork, read)
      return args
    }
    const verb = method || (input || Object.keys(fields).length ? 'POST' : 'GET')
    if (!['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(verb)) failure()
    const plain = path.split('?')[0]!.toLowerCase(), target = `repos/${fork.toLowerCase()}`
    if (plain === target || plain.startsWith(`${target}/`)) {
      if (verb !== 'GET' && verb !== 'HEAD') {
        const resource = plain.slice(target.length)
        const writes: Record<string, RegExp> = {
          POST: /^\/(?:issues|issues\/\d+\/(?:comments|labels|assignees)|pulls|pulls\/\d+\/(?:comments(?:\/\d+\/replies)?|reviews|requested_reviewers))$/,
          PATCH: /^\/(?:issues\/\d+|issues\/comments\/\d+|pulls\/\d+|pulls\/comments\/\d+)$/,
          PUT: /^\/issues\/\d+\/labels$/,
          DELETE: /^\/(?:issues\/comments\/\d+|pulls\/comments\/\d+|issues\/\d+\/(?:labels\/[^/]+|assignees))$/,
        }
        if (!writes[verb]?.test(resource)) failure()
        const [owner, name] = fork.split('/'), canonical = await read(REPOSITORY, { owner, name })
        if (canonical.repository?.nameWithOwner.toLowerCase() !== fork.toLowerCase()) failure()
      }
      return args
    }
    if (verb !== 'GET' && verb !== 'HEAD') failure()
    const source = `repos/${upstream.toLowerCase()}`
    if (plain === source || plain.startsWith(`${source}/`) || plain === 'user' || plain === 'notifications') return args
    failure()
  }
  const allowed: Record<string, string[]> = {
    issue: ['list', 'view', 'status', 'create', 'comment', 'edit', 'close', 'reopen'],
    pr: ['list', 'view', 'status', 'diff', 'checks', 'create', 'comment', 'edit', 'checkout'],
    run: ['list', 'view', 'download', 'watch'],
  }
  if (!allowed[args[0] ?? '']?.includes(args[1] ?? '')) failure()
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!
    if (/^--(?:project|add-project|remove-project|recover|web|hostname)(?:=|$)/.test(arg)) failure()
    if (arg === '--repo' || arg === '-R') { if (args[++i]?.toLowerCase() !== fork.toLowerCase()) failure() }
    else if (arg.startsWith('--repo=') && arg.slice(7).toLowerCase() !== fork.toLowerCase()) failure()
    else if (arg.startsWith('-R') && arg.slice(2).toLowerCase() !== fork.toLowerCase()) failure()
    else if (['--body', '-b', '--title', '-t', '--body-file', '-F', '--head', '-H', '--base', '-B', '--label', '-l',
      '--assignee', '-a', '--reviewer', '-r', '--milestone', '-m'].includes(arg)) { if (args[++i] === undefined) failure() }
    // URL positional selectors can override --repo in gh.
    else if (/^https?:\/\//.test(arg) && !arg.startsWith(`https://github.com/${fork}/`)) failure()
  }
  const [owner, name] = fork.split('/'), canonical = await read(REPOSITORY, { owner, name })
  if (canonical.repository?.nameWithOwner.toLowerCase() !== fork.toLowerCase()) failure()
  return [...args, '--repo', fork]
}

async function main(): Promise<void> {
  const [flag, file, separator, ...args] = process.argv.slice(2)
  if (flag !== '--config' || !file || separator !== '--') failure()
  const config = Configuration.parse(JSON.parse(await readFile(file, 'utf8')))
  const run = async (args: string[]) => {
    const [program, ...rest] = nativeCommand([config.cli, ...args])
    try { return (await exec(program!, rest, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 90000 })).stdout }
    catch (error) { throw commandError(error, 'gh') }
  }
  const read: GraphCall = async (query, variables) => {
    const fields = Object.entries(variables).flatMap(([key, value]) => Array.isArray(value)
      ? value.flatMap(item => ['-f', `${key}[]=${item}`]) : ['-f', `${key}=${value}`])
    const response = JSON.parse(await run(['api', 'graphql', '-f', `query=${query}`, ...fields]))
    if (response.errors || !response.data) failure()
    return response.data
  }
  if (args[0] === 'auth' && args[1] === 'git-credential' && args.length === 3 && ['get', 'store', 'erase'].includes(args[2]!)) {
    let input = ''
    for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 65536) failure() }
    const fields = Object.fromEntries(input.trim().split(/\r?\n/).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
    if (fields.host !== 'github.com' || fields.protocol !== 'https'
      || fields.path?.replace(/\.git$/, '').toLowerCase() !== config.fork.toLowerCase()) failure()
    const [owner, name] = config.fork.split('/'), canonical = await read(REPOSITORY, { owner, name })
    if (canonical.repository?.nameWithOwner.toLowerCase() !== config.fork.toLowerCase()) failure()
    const [program, ...rest] = nativeCommand([config.cli, ...args])
    await new Promise<void>((resolve, reject) => {
      const child = execFile(program!, rest, { windowsHide: true, maxBuffer: 65536, timeout: 90000 },
        (error, stdout) => { if (error) reject(commandError(error, 'gh')); else { process.stdout.write(stdout); resolve() } })
      child.stdin?.end(input)
    })
    return
  }
  process.stdout.write(await run(await guardArguments(config, args, read)))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
