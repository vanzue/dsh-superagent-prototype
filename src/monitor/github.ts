/** Anonymous, GET-only GitHub REST reader. No CLI, credentials, mutation endpoint or model is reachable here. */
import { z } from 'zod'
import { MonitorConfig, type MonitorActivity, type MonitorItem, type MonitorSnapshot } from './model.ts'

const ENDPOINTS = ['', 'issues', 'pulls', 'issues/comments', 'pulls/comments', 'events', 'actions/runs'] as const
type Endpoint = typeof ENDPOINTS[number]
const User = z.object({ login: z.string() }).nullish()
const Issue = z.object({
  number: z.number().int().positive(), title: z.string(), html_url: z.string(), user: User, updated_at: z.string(),
  state: z.string(), draft: z.boolean().optional(), pull_request: z.unknown().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).default([]),
})
const Comment = z.object({
  id: z.number(), body: z.string().nullish(), html_url: z.string(), user: User, updated_at: z.string(),
})
const EventSubject = z.object({ number: z.number(), title: z.string() })
const Event = z.object({
  id: z.string(), type: z.string(), actor: User, created_at: z.string(),
  payload: z.object({ action: z.string().optional(), issue: EventSubject.optional(), pull_request: EventSubject.optional() }),
})
const WorkflowRun = z.object({
  id: z.number(), display_title: z.string(), html_url: z.string(), head_branch: z.string().nullable(),
  status: z.string(), conclusion: z.string().nullable(), updated_at: z.string(),
  pull_requests: z.array(z.object({ number: z.number() })).default([]),
})

/** Limits requests to a fixed repository and endpoint allowlist, and respects GitHub's shared anonymous rate budget. */
export class MonitorGithub {
  readonly repository: string
  remaining?: number
  resetAt?: string
  retryAt = 0
  requests = 0
  constructor(repository: string, private readonly transport: typeof fetch = fetch) {
    this.repository = MonitorConfig.parse({ repository }).repository
  }
  async get(endpoint: Endpoint, query: Record<string, string>, signal: AbortSignal): Promise<{ data: unknown; more: boolean }> {
    if (!ENDPOINTS.includes(endpoint)) throw new Error('Monitoring endpoint is not allowed')
    if (Date.now() < this.retryAt) throw new Error(`GitHub rate limit; retry after ${new Date(this.retryAt).toISOString()}`)
    if (this.remaining !== undefined && this.remaining <= 2 && this.resetAt && Date.now() < Date.parse(this.resetAt)) {
      this.retryAt = Date.parse(this.resetAt) + 2000
      throw new Error(`GitHub rate limit; retry after ${new Date(this.retryAt).toISOString()}`)
    }
    const url = new URL(`https://api.github.com/repos/${this.repository}${endpoint ? `/${endpoint}` : ''}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    this.requests++
    const response = await this.transport(url, {
      method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-superagent-readonly-monitor', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    })
    const remaining = response.headers.get('x-ratelimit-remaining'), reset = response.headers.get('x-ratelimit-reset')
    if (remaining !== null && Number.isFinite(Number(remaining))) this.remaining = Number(remaining)
    if (reset !== null && Number.isFinite(Number(reset))) this.resetAt = new Date(Number(reset) * 1000).toISOString()
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        const retry = Number(response.headers.get('retry-after'))
        this.retryAt = Math.max(Date.now() + (retry > 0 ? retry : 60) * 1000,
          this.remaining === 0 && this.resetAt ? Date.parse(this.resetAt) + 2000 : 0)
      }
      await response.body?.cancel()
      throw new Error(`GitHub ${endpoint || 'repository'}: HTTP ${response.status}${this.retryAt > Date.now()
        ? `; retry after ${new Date(this.retryAt).toISOString()}` : ''}`)
    }
    return { data: await response.json(), more: /rel="next"/.test(response.headers.get('link') ?? '') }
  }
  async snapshot(signal: AbortSignal, now = new Date()): Promise<MonitorSnapshot> {
    const since = new Date(now.getTime() - 7 * 86400_000).toISOString()
    const repository = z.object({ full_name: z.string(), default_branch: z.string(), private: z.literal(false) })
      .parse((await this.get('', {}, signal)).data)
    if (repository.full_name.toLowerCase() !== this.repository.toLowerCase()) throw new Error('Repository identity changed; configure a new monitor')
    const base = `https://github.com/${this.repository}`
    const link = (url: string): string => {
      try {
        const parsed = new URL(url)
        if (parsed.origin === 'https://github.com' && !parsed.username && !parsed.password
          && parsed.pathname.toLowerCase().startsWith(`/${this.repository.toLowerCase()}/`)) return parsed.href
      } catch { /* Invalid external links fall back to the repository. */ }
      return base
    }
    const warnings: string[] = []
    const reader = this
    async function* pages<T>(endpoint: Endpoint, query: Record<string, string>, schema: z.ZodType<T>, max = 20): AsyncGenerator<T[]> {
      for (let page = 1; page <= max; page++) {
        try {
          const result = await reader.get(endpoint, { ...query, per_page: '100', page: String(page) }, signal)
          const data = endpoint === 'actions/runs' ? z.object({ workflow_runs: z.array(schema) }).parse(result.data).workflow_runs
            : z.array(schema).parse(result.data)
          yield data
          if (!result.more) break
          if (page === max) warnings.push(`${endpoint}: limited to ${max * 100} records; this section is incomplete.`)
        } catch (error) {
          signal.throwIfAborted()
          warnings.push(`${endpoint}: incomplete. ${error instanceof Error ? error.message : String(error)}`)
          break
        }
      }
    }
    const collect = async <T>(pages: AsyncGenerator<T[]>): Promise<T[]> => {
      const items: T[] = []
      for await (const page of pages) items.push(...page)
      return items
    }
    const item = (value: z.infer<typeof Issue>): MonitorItem => ({
      number: value.number, title: value.title, url: link(value.html_url), author: value.user?.login ?? '',
      updatedAt: value.updated_at, labels: value.labels.map(label => typeof label === 'string' ? label : label.name),
      draft: value.draft ?? false, state: value.state,
    })
    const open = await collect(pages('issues', { state: 'open', sort: 'updated', direction: 'desc' }, Issue))
    const pulls = await collect(pages('pulls', { state: 'open', sort: 'updated', direction: 'desc' }, Issue))
    const runs: z.infer<typeof WorkflowRun>[] = [], comments: z.infer<typeof Comment>[] = [], reviews: z.infer<typeof Comment>[] = []
    const updated: z.infer<typeof Issue>[] = [], events: z.infer<typeof Event>[] = []
    const advance = <T>(pages: AsyncGenerator<T[]>, into: T[]) => async (): Promise<boolean> => {
      const next = await pages.next()
      if (next.done) return false
      into.push(...next.value)
      return true
    }
    // Interleave history pages so busy CI cannot consume the entire budget before comments and reviews are read.
    let pending = [
      advance(pages('issues/comments', { since, sort: 'updated', direction: 'desc' }, Comment), comments),
      advance(pages('pulls/comments', { since, sort: 'updated', direction: 'desc' }, Comment), reviews),
      advance(pages('issues', { state: 'all', since, sort: 'updated', direction: 'desc' }, Issue), updated),
      advance(pages('events', {}, Event, 3), events),
      advance(pages('actions/runs', { created: `>=${since}` }, WorkflowRun), runs),
    ]
    while (pending.length) {
      const next: typeof pending = []
      for (const advance of pending) if (await advance()) next.push(advance)
      pending = next
    }
    // The public event feed is delayed and capped by GitHub; it is never a complete audit log.
    warnings.push('Public events (including review decisions) can be delayed and cover at most 300 events; seven-day coverage is not guaranteed. CI lists workflow runs, not every external check.')
    const comment = (value: z.infer<typeof Comment>, kind: string): MonitorActivity => ({
      id: `${kind}:${value.id}`, kind, title: (value.body ?? '').slice(0, 400), url: link(value.html_url),
      actor: value.user?.login ?? '', at: value.updated_at,
    })
    const activity: MonitorActivity[] = [
      ...comments.map(value => comment(value, 'comment')),
      ...reviews.map(value => comment(value, 'review-comment')),
      ...updated.map(value => ({
        id: `updated:${value.number}`, kind: value.pull_request ? 'pr-updated' : 'issue-updated',
        title: `#${value.number} ${value.title} (${value.state})`, url: link(value.html_url), actor: '', at: value.updated_at,
      })),
      ...events.filter(value => !['IssueCommentEvent', 'PullRequestReviewCommentEvent'].includes(value.type)).map(value => {
        const subject = value.payload.pull_request ?? value.payload.issue
        return { id: `event:${value.id}`, kind: value.type, title: [value.payload.action,
          subject ? `#${subject.number} ${subject.title}` : ''].filter(Boolean).join(' ') || value.type,
        url: subject ? `${base}/${value.payload.pull_request ? 'pull' : 'issues'}/${subject.number}` : base,
        actor: value.actor?.login ?? '', at: value.created_at }
      }),
    ]
    return {
      repository: this.repository, defaultBranch: repository.default_branch, syncedAt: now.toISOString(), since,
      issues: open.filter(value => !value.pull_request).map(item), pulls: pulls.map(item),
      activity: [...new Map(activity.filter(value => value.at >= since).map(value => [value.id, value])).values()]
        .sort((a, b) => b.at.localeCompare(a.at)),
      runs: runs.map(value => ({ id: value.id, title: value.display_title, url: link(value.html_url), branch: value.head_branch ?? '',
        status: value.status, conclusion: value.conclusion ?? '', at: value.updated_at, pulls: value.pull_requests.map(pull => pull.number) })),
      warnings,
    }
  }
}
