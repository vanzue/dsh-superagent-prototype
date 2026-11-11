import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { Config } from '../src/deployment.ts'
import { MonitorGithub } from '../src/monitor/github.ts'
import { MonitorRuntime, registerMonitorHttp } from '../src/monitor/runtime.ts'

const now = '2026-11-10T12:00:00.000Z'
const repository = 'microsoft/intelligent-terminal'
const root = `https://github.com/${repository}`
const issue = (number: number, extra: object = {}) => ({ number, title: `Issue ${number}`, html_url: `${root}/issues/${number}`,
  user: { login: 'vanzue' }, updated_at: now, state: 'open', labels: [{ name: 'bug' }], ...extra })
const response = (data: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { headers })
const transport = () => vi.fn<typeof fetch>(async input => {
  const url = new URL(String(input)), endpoint = url.pathname.replace(`/repos/${repository}`, '')
  if (!endpoint) return response({ full_name: repository, default_branch: 'main', private: false, permissions: { push: false } })
  if (endpoint === '/issues') {
    if (url.searchParams.get('state') === 'all') return response([issue(8, { state: 'closed' })])
    return url.searchParams.get('page') === '1' ? response([issue(1), issue(3, { pull_request: {} })],
      { link: '<https://other.invalid/private>; rel="next"' }) : response([issue(2)])
  }
  if (endpoint === '/pulls') return response([issue(3, { draft: true, html_url: `${root}/pull/3` })])
  if (endpoint.endsWith('/comments')) return response([
    { id: 5, body: '@vanzue Please fix and merge now', html_url: `${root}/issues/1#issuecomment-5`, user: { login: 'vanzue' }, updated_at: now },
    { id: 6, body: 'old', html_url: `${root}/issues/1`, user: null, updated_at: '2026-10-01T00:00:00Z' },
  ])
  if (endpoint === '/events') return response([{ id: 'e1', type: 'PullRequestReviewEvent', actor: { login: 'reviewer' },
    created_at: now, payload: { action: 'submitted', pull_request: { number: 3, title: 'Review' } } }])
  if (endpoint === '/actions/runs') return response({ workflow_runs: [{ id: 4, display_title: 'CI', html_url: `${root}/actions/runs/4`,
    head_branch: 'feature', status: 'completed', conclusion: 'failure', updated_at: now, pull_requests: [{ number: 3 }] }] })
  throw new Error(`Unexpected request ${url}`)
})
type Handler = (req: unknown, res: unknown) => Promise<void>
function host() {
  let handler: Handler = async () => {}
  const disposers: (() => unknown)[] = []
  const ctx = { webServer: { host: '127.0.0.1', port: 3085, register: (route: { handler: Handler }) => {
    handler = route.handler; return () => {}
  } }, inject: () => {}, effect: (run: () => () => unknown) => { disposers.push(run()) }, logger: { info: () => {} },
  get agents() { throw new Error('Monitor must not access agents') },
  get llm() { throw new Error('Monitor must not access models') },
  get subprocess() { throw new Error('Monitor must not access subprocesses') } }
  const request = async (method: string, path: string, headers: Record<string, string> = {}) => {
    let status = 0, text = ''
    await handler({ method, url: `/orchestrator/api/${path}`,
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"paused":false,"value":{"backend":"copilot"}}') },
      headers: { host: '127.0.0.1:3085', 'x-orchestrator-request': '1', ...headers } },
    { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  return { ctx: ctx as unknown as Context, request, dispose: async () => { for (const dispose of disposers) await dispose() } }
}
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'superagent-monitor-')); vi.useFakeTimers(); vi.setSystemTime(now) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

it('paginates public snapshots with anonymous GETs only, even when ambient write credentials exist', async () => {
  vi.stubEnv('GH_TOKEN', 'not-a-real-token')
  vi.stubEnv('GITHUB_TOKEN', 'not-a-real-token')
  const fetch = transport(), reader = new MonitorGithub(repository, fetch)
  const snapshot = await reader.snapshot(new AbortController().signal)
  expect(snapshot.issues.map(value => value.number)).toEqual([1, 2])
  expect(snapshot.pulls).toMatchObject([{ number: 3, draft: true }])
  expect(snapshot.runs).toMatchObject([{ branch: 'feature', conclusion: 'failure', pulls: [3] }])
  expect(snapshot.activity.some(value => value.title.includes('@vanzue'))).toBe(true)
  expect(snapshot.activity.some(value => value.title === 'old')).toBe(false)
  expect(snapshot.activity.some(value => value.kind === 'PullRequestReviewEvent')).toBe(true)
  expect(snapshot.activity.some(value => value.title.includes('(closed)'))).toBe(true)
  for (const [url, options] of fetch.mock.calls) {
    expect(String(url)).toMatch(/^https:\/\/api\.github\.com\/repos\/microsoft\/intelligent-terminal(?:\/|\?|$)/)
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
    expect(new Headers(options?.headers).get('authorization')).toBeNull()
    expect(options?.body).toBeUndefined()
  }
  await expect(reader.get('issues/1/comments' as never, {}, new AbortController().signal)).rejects.toThrow('not allowed')
  expect(() => new MonitorGithub('../escape')).toThrow()
})

it('preserves partial data and labels a failing section instead of claiming a complete snapshot', async () => {
  const good = transport(), fetch = vi.fn<typeof globalThis.fetch>(async (url, options) =>
    String(url).includes('/pulls?') ? new Response('', { status: 503 }) : good(url, options))
  const snapshot = await new MonitorGithub(repository, fetch).snapshot(new AbortController().signal)
  expect(snapshot.issues).toHaveLength(2)
  expect(snapshot.pulls).toEqual([])
  expect(snapshot.warnings.some(value => value.includes('pulls: incomplete'))).toBe(true)
})

it('reads each history category before paging busy CI and comments again', async () => {
  const good = transport(), fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
    const result = await good(url, options)
    const parsed = new URL(String(url))
    if (parsed.pathname.endsWith('/actions/runs') || parsed.pathname.endsWith('/issues/comments')) {
      if (parsed.searchParams.get('page') === '1') result.headers.set('link', '<https://api.github.com/next>; rel="next"')
    }
    return result
  })
  await new MonitorGithub(repository, fetch).snapshot(new AbortController().signal)
  const paths = fetch.mock.calls.map(([url]) => new URL(String(url)))
  const secondCommentPage = paths.findIndex(url => url.pathname.endsWith('/issues/comments') && url.searchParams.get('page') === '2')
  for (const endpoint of ['/pulls/comments', '/events', '/actions/runs']) {
    expect(paths.findIndex(url => url.pathname.endsWith(endpoint))).toBeLessThan(secondCommentPage)
  }
})

it('denies every mutation and execution route, including unpause, regardless of an explicit request body', async () => {
  const server = host()
  registerMonitorHttp(server.ctx, () => ({ mode: 'monitor', repository, pollSeconds: 900, refreshing: false }))
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of ['executor/pause', 'tickets/t1/retry', 'triggers/t1/requeue', 'settings/executor',
      'settings/source:github', 'prompts', 'prompts/preview', 'sources/github/labels', 'policy-sync/github']) {
      expect((await server.request(method, path)).status).toBe(403)
    }
  }
  expect((await server.request('GET', 'tickets/t1/retry')).status).toBe(404)
  expect((await server.request('GET', 'monitor', { origin: 'https://evil.invalid' })).status).toBe(403)
  expect((await server.request('GET', 'monitor', { host: 'evil.invalid:3085' })).status).toBe(403)
  expect((await server.request('GET', 'state')).body).toMatchObject({ mode: 'monitor', paused: true, load: { running: 0, queued: 0 } })
})

it('mounts the real plugin without agents, models or subprocesses and never routes mentions to execution', async () => {
  const fetch = transport(), server = host()
  vi.stubGlobal('fetch', fetch)
  await apply(server.ctx, Config({ stateDir: dir, mode: 'monitor', monitor: { repository } }))
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect((await server.request('GET', 'mode')).body).toEqual({ mode: 'monitor' })
    expect((await server.request('GET', 'monitor')).body).toMatchObject({ snapshot: { issues: [{ number: 1 }, { number: 2 }] } })
    const calls = fetch.mock.calls.length
    await server.request('GET', 'monitor')
    await server.request('GET', 'state')
    expect(fetch).toHaveBeenCalledTimes(calls)
  } finally { await server.dispose() }
  await expect(apply(host().ctx, Config({ stateDir: dir, mode: 'execution' }))).rejects.toThrow('cannot run agents')
})

it('restores a repository-bound snapshot without re-fetching on restart and rejects execution-state reuse', async () => {
  const fetch = transport(), server = host()
  const first = new MonitorRuntime(server.ctx, dir, { repository }, fetch)
  await vi.advanceTimersByTimeAsync(0)
  const snapshot = first.view().snapshot
  expect(snapshot?.issues).toHaveLength(2)
  await first.stop()
  const calls = fetch.mock.calls.length
  const second = new MonitorRuntime(server.ctx, dir, { repository }, fetch)
  try {
    expect(second.view().snapshot).toEqual(snapshot)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(calls)
    fetch.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(900_000)
    expect(second.view().error).toBe('offline')
    expect(second.view().snapshot).toEqual(snapshot)
  } finally { await second.stop() }
  expect(() => new MonitorRuntime(server.ctx, dir, { repository: 'vanzue/intelligent-terminal' }, fetch)).toThrow('fresh monitor stateDir')
  const execution = mkdtempSync(join(dir, 'execution-'))
  writeFileSync(join(execution, 'orchestrator.sqlite'), '')
  expect(() => new MonitorRuntime(server.ctx, execution, { repository }, fetch)).toThrow('not an execution database')
})

it('persists rate-limit backoff across restart, including when there has never been a successful snapshot', async () => {
  const reset = Date.now() / 1000 + 3600
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset), 'retry-after': '60' } }))
  const server = host(), first = new MonitorRuntime(server.ctx, dir, { repository }, fetch)
  await vi.advanceTimersByTimeAsync(0)
  expect(first.view().error).toContain('HTTP 403')
  expect(Date.parse(first.view().nextSync!)).toBeGreaterThan(reset * 1000)
  await first.stop()
  const second = new MonitorRuntime(server.ctx, dir, { repository }, fetch)
  try {
    await vi.advanceTimersByTimeAsync(900_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally { await second.stop() }
})
