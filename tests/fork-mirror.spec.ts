import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { guardArguments, guardGraph } from '../src/infra/fork-gh.ts'
import { MUTATIONS, ForkGithub, type RemoteText, type RemoteThread } from '../src/mirror/github.ts'
import { marker, mirrorBodies, reconcile, watchMirror, MIRROR_STATUS, type MirrorStatus } from '../src/mirror/sync.ts'
import { discussionTrigger, discussionKind } from '../src/sources/discussions.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { startRuntime, feishu } from './fixtures/host.ts'

const config = { fork: 'vanzue/intelligent-terminal', upstream: 'microsoft/intelligent-terminal', cli: 'unused' }
const own = async () => ({ repository: { id: 'fork', nameWithOwner: config.fork, discussionCategories: { nodes: [{ id: 'category' }] } } })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('allows scoped reads and fork writes while denying upstream, transfer, traversal and unscoped commands', async () => {
  for (const args of [
    ['api', `repos/${config.upstream}/issues`],
    ['api', `repos/${config.fork}/issues`, '--method', 'POST', '-f', 'title=test'],
    ['api', 'user', '--jq', '.login'],
  ]) expect(await guardArguments(config, args, own)).toEqual(args)
  expect(await guardArguments(config, ['pr', 'create', '--title', 'test', '--body', `https://github.com/${config.upstream}/issues/1`], own))
    .toContain(config.fork)
  for (const args of [
    ['api', `repos/${config.upstream}/issues`, '-f', 'title=test'],
    ['api', `repos/${config.fork}/transfer`, '-X', 'POST', '-f', 'new_owner=microsoft'],
    ['api', `repos/${config.fork}/../other/issues`, '-X', 'POST'],
    ['api', `repos/${config.fork}/%2e%2e/issues`, '-X', 'POST'],
    ['api', 'https://other.invalid/repos/x/y', '-X', 'POST'],
    ['issue', 'transfer', '1', config.upstream],
    ['pr', 'create', '--repo', config.upstream],
    ['pr', 'view', `https://github.com/${config.upstream}/pull/1`],
    ['issue', 'edit', '1', '--add-project', 'some-project'],
    ['auth', 'token'],
    ['api', 'user', '-H', 'Authorization: secret'],
  ]) await expect(guardArguments(config, args, own), JSON.stringify(args)).rejects.toThrow('denied')
  await expect(guardArguments(config, ['api', `repos/${config.fork}/issues`, '-X', 'POST'],
    async () => ({ repository: { nameWithOwner: config.upstream } }))).rejects.toThrow('denied')
})

it('checks every GraphQL mutation node and rejects arbitrary mutations before they can be forwarded', async () => {
  await guardGraph('query { viewer { login } }', {}, config.fork, own)
  await guardGraph(MUTATIONS.createDiscussion, { repo: 'fork', category: 'category' }, config.fork, own)
  await expect(guardGraph(MUTATIONS.createDiscussion, { repo: 'upstream', category: 'category' }, config.fork, own)).rejects.toThrow('denied')
  await expect(guardGraph('mutation { deleteIssue(input:{issueId:"upstream"}){clientMutationId} }', {}, config.fork, own)).rejects.toThrow('denied')
  await expect(guardGraph(MUTATIONS.addDiscussionComment, { id: 'fork-discussion', parent: 'upstream-comment' }, config.fork,
    async () => ({ nodes: [{ repository: { nameWithOwner: config.fork } }, { discussion: { repository: { nameWithOwner: config.upstream } } }] })))
    .rejects.toThrow('denied')
  await guardGraph(MUTATIONS.updateDiscussionComment, { id: 'fork-comment' }, config.fork,
    async () => ({ nodes: [{ discussion: { repository: { nameWithOwner: config.fork } } }] }))
})

it('validates JSON file payloads, including long bodies, without accepting hidden GraphQL mutations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fork-guard-'))
  try {
    const file = join(dir, 'payload.json')
    writeFileSync(file, JSON.stringify({ body: 'x'.repeat(65000) }))
    const args = ['api', `repos/${config.fork}/issues/1/comments`, '--method', 'POST', '--input', file]
    expect(await guardArguments(config, args, own)).toEqual(args)
    writeFileSync(file, JSON.stringify({ query: 'mutation { arbitrary }', variables: {} }))
    await expect(guardArguments(config, ['api', 'graphql', '--input', file], own)).rejects.toThrow('denied')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const remote = (id: string, body = '@vanzuefun original request'): RemoteThread => ({
  id, restId: 1, number: 1, title: 'Original issue', body, author: 'original-user', url: `https://github.com/${config.upstream}/issues/1`,
  createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-02T00:00:00Z', closed: true,
})
function mirrorFixture() {
  const source = remote('up-issue'), comment = remote('up-comment', 'Original comment')
  const threads: RemoteThread[] = [], comments: RemoteText[] = []
  let writes = 0, uncertain = false, removed = false
  const client = {
    upstream: config.upstream, fork: config.fork,
    issues: async (repo: string) => structuredClone(repo === config.upstream ? [source] : threads),
    discussions: async () => [],
    issueComments: async (repo: string) => structuredClone(repo === config.upstream ? removed ? [] : [comment] : comments),
    createIssue: async (title: string, body: string) => {
      writes++
      const value = { ...remote('fork-issue', body), number: 10, title, closed: false, author: 'vanzuefun', url: `https://github.com/${config.fork}/issues/10` }
      threads.push(value)
      if (uncertain) { uncertain = false; throw new Error('Response lost after create') }
      return structuredClone(value)
    },
    updateIssue: async (_number: number, title: string, body: string, closed: boolean) => { writes++; Object.assign(threads[0]!, { title, body, closed }) },
    writeIssueComment: async (_number: number, body: string, existing?: RemoteText) => {
      writes++
      if (existing) { const found = comments.find(value => value.id === existing.id)!; found.body = body; return structuredClone(found) }
      const value = { ...remote(`fork-comment-${comments.length}`, body), author: 'vanzuefun' }
      comments.push(value); return structuredClone(value)
    },
  } as unknown as ForkGithub
  const status: MirrorStatus = { upstream: config.upstream, fork: config.fork, phase: 'running', issues: 0, discussions: 0, comments: 0, changes: 0, recent: [] }
  return { source, comment, threads, comments, get writes() { return writes }, loseResponse: () => { uncertain = true }, removeComment: () => { removed = true },
    run: () => reconcile(client, 'vanzuefun', status, () => {}, run => run()) }
}

it('recovers uncertain creates, updates owned mirrors idempotently and never overwrites local conversations', async () => {
  const mirror = mirrorFixture()
  mirror.loseResponse()
  await expect(mirror.run()).rejects.toThrow('Response lost')
  expect(mirror.threads).toHaveLength(1)
  await mirror.run()
  expect(mirror.threads).toHaveLength(1)
  expect(mirror.threads[0]?.closed).toBe(true)
  expect(mirror.comments).toHaveLength(1)
  const writes = mirror.writes
  await mirror.run()
  expect(mirror.writes).toBe(writes)
  const local = { ...remote('local', 'Keep my local discussion'), author: 'vanzue' }
  mirror.comments.push(local)
  mirror.comment.body = 'Edited upstream comment'
  await mirror.run()
  expect(mirror.comments[0]!.body).toContain('Edited upstream comment')
  expect(mirror.comments[1]).toEqual(local)
  mirror.removeComment()
  await mirror.run()
  expect(mirror.comments[0]!.body).toContain('[Removed upstream; retained for history]')
  expect(mirror.comments[1]).toEqual(local)
})

it('keeps long source text complete, inert and consistently identified across chunks', () => {
  const source = remote('long', '`'.repeat(30000) + '~'.repeat(30000) + '@someone #123\n' + '😀'.repeat(20000))
  const bodies = mirrorBodies(config.upstream, source)
  expect(bodies.length).toBeGreaterThan(2)
  expect(bodies.every(body => body.length < 65536)).toBe(true)
  expect(bodies[0]).toContain(marker(config.upstream, source.id))
  expect(bodies[0]).toContain(`Mirrored from \`${source.url}\``)
  expect(bodies.join('')).toContain('@someone #123')
  expect(bodies.join('')).not.toContain('\uFFFD')
  const copied = discussionTrigger({ ...source, author: 'vanzuefun' }, { ...source, author: 'vanzuefun' }, 'vanzuefun', true)
  expect(copied.human).toBe(false)
})

it('enforces fresh allowlisted explicit mentions before routing, including followups and tool settings changes', async () => {
  const host = await startRuntime(undefined, { explicitMentionsOnly: true })
  try {
    const original = feishu('1', 'explicit request')
    const fresh = { ...original, at: new Date().toISOString(), meta: { ...original.meta, createdAt: new Date().toISOString() } }
    expect(host.runtime.receive({ ...fresh, addressed: undefined })).toBe('filtered')
    expect(host.runtime.receive({ ...fresh, human: false })).toBe('filtered')
    expect(host.runtime.receive({ ...fresh, meta: { createdAt: '2020-01-01T00:00:00Z' } })).toBe('filtered')
    expect(host.runtime.receive({ ...fresh, actor: { source: fresh.source, id: 'outsider' } })).toBe('filtered')
    expect(host.runtime.receive(fresh)).toBe('stored')
    const current = host.runtime.store.settings()
    await expect(host.runtime.settings.save('policy', { ...current.policy, sources: {} },
      host.runtime.store.blockRevision('policy'), 'tool')).rejects.toThrow()
  } finally { await host.stop() }
})

it('reads every REST/GraphQL page and reply without putting long input bodies on the command line', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mirror-pages-'))
  const text = { id: 'comment', body: 'body', url: 'https://github.com/x/y', createdAt: '2020-01-01', updatedAt: '2020-01-02', author: { login: 'alice' } }
  const calls: string[] = []
  try {
    const client = new ForkGithub(config.upstream, config.fork, directory, async args => {
      expect(args.join(' ').length).toBeLessThan(1000)
      calls.push(args[1]!)
      if (args[1] !== 'graphql') {
        const row = { id: 1, node_id: 'issue', title: 'issue', body: '', html_url: '', state: 'open', number: 1, labels: [], user: { login: 'a' } }
        return JSON.stringify(/[?&]page=1(?:&|$)/.test(args[1]!) ? Array.from({ length: 100 }, () => row) : [row])
      }
      const { query, variables } = JSON.parse(readFileSync(args[args.indexOf('--input') + 1]!, 'utf8'))
      const page = { hasNextPage: !variables.after, endCursor: 'next' }
      if (query.includes('discussions(first:')) return JSON.stringify({ data: { repository: { discussions: {
        nodes: [{ ...text, number: 1, title: 'discussion', closed: false, category: { name: 'General' } }], pageInfo: page } } } })
      if (query.includes('comments(first:')) return JSON.stringify({ data: { node: { repository: { nameWithOwner: config.upstream },
        comments: { nodes: [{ ...text, replies: { totalCount: 2 } }], pageInfo: { hasNextPage: false } } } } })
      return JSON.stringify({ data: { node: { discussion: { repository: { nameWithOwner: config.upstream } },
        replies: { nodes: [{ ...text, id: `reply-${variables.after ?? 'first'}` }], pageInfo: page } } } })
    })
    expect(await client.issues(config.upstream)).toHaveLength(101)
    expect(await client.discussions(config.upstream)).toHaveLength(2)
    const comments = await client.discussionComments(config.upstream, 'discussion')
    expect(comments.map(value => value.parent)).toEqual([undefined, 'comment', 'comment'])
    expect(calls).toHaveLength(7)
    expect(readdirSync(directory)).toEqual([])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('restores a persisted daily schedule without writing or starting an agent', async () => {
  vi.useFakeTimers()
  const state = new Map<string, unknown>()
  const saved = { nextRunAt: new Date(Date.now() + 86400000).toISOString(), issues: 259, discussions: 16, comments: 1000 }
  state.set(MIRROR_STATUS, saved)
  const run = vi.fn(), receive = vi.fn(), stop = new AbortController()
  const ctx = { ready: Promise.resolve(), configured: () => true,
    config: () => ({ upstream: config.upstream, intervalHours: 24, writeSeconds: 12 }),
    deployment: { repository: config.fork }, state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => state.set(key, value) },
    commands: { run }, receive, report: vi.fn(),
  } as unknown as SourceContext
  const pending = watchMirror(ctx, stop.signal)
  await vi.advanceTimersByTimeAsync(120000)
  expect(run).not.toHaveBeenCalled()
  expect(receive).not.toHaveBeenCalled()
  expect(state.get(MIRROR_STATUS)).toEqual(saved)
  stop.abort(); await pending
})

it('keeps Discussion replies in their fork parent and deduplicates uncertain delivery', async () => {
  const thread = { ...remote('discussion'), url: `https://github.com/${config.fork}/discussions/1` }
  const parent = { ...remote('parent'), author: 'vanzue' }, replies: RemoteText[] = [parent]
  vi.spyOn(ForkGithub.prototype, 'discussions').mockResolvedValue([thread])
  vi.spyOn(ForkGithub.prototype, 'discussionComments').mockImplementation(async () => replies)
  const send = vi.spyOn(ForkGithub.prototype, 'writeDiscussionComment').mockImplementation(async (id, body, parent) => {
    const reply = { ...remote('sent', body), author: 'vanzuefun', parent }; replies.push(reply); return reply
  })
  const ctx = { commands: { repository: config.fork, deployment: { stateDir: tmpdir(), github: { login: 'vanzuefun' } } } } as SourceContext
  const trigger = discussionTrigger(thread, parent, 'vanzuefun')
  const message = { id: 'receipt', channel: trigger.channel!, text: 'Done', kind: 'reply' as const }
  await discussionKind.channel!.send!(ctx, message)
  await discussionKind.channel!.send!(ctx, message)
  expect(send).toHaveBeenCalledExactlyOnceWith('discussion', expect.stringContaining('dsh-superagent:receipt'), 'parent')
  await expect(discussionKind.channel!.send!(ctx, { ...message, channel: { ...message.channel, address: { ...message.channel.address, id: 'upstream' } } }))
    .rejects.toThrow('missing or changed')
})
