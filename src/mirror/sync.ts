/** Daily full reconciliation to fork-owned mirror posts, with paced writes and durable restart-safe scheduling. */
import { z } from 'zod'
import { join } from 'node:path'
import { key } from '../core/index.ts'
import { record } from '../kv.ts'
import { pause } from '../sources/poll.ts'
import type { SourceContext } from '../sources/host.ts'
import { ForkGithub, type RemoteText, type RemoteThread } from './github.ts'

export const MirrorConfig = z.object({ upstream: z.string().default(''), intervalHours: z.number().int().min(24).max(168).default(24),
  writeSeconds: z.number().int().min(10).max(120).default(12) }).strict()
export interface MirrorStatus {
  upstream: string; fork: string; phase: 'running' | 'idle' | 'error'
  startedAt?: string; completedAt?: string; nextRunAt?: string; lastWriteAt?: string; error?: string
  issues: number; discussions: number; comments: number; changes: number
  recent: { title: string; upstream: string; fork: string }[]
}
export const MIRROR_STATUS = record<MirrorStatus>('github-mirror:status')
export const MIRROR_BINDING = record<{ upstream: string; fork: string }>('github-mirror:binding')
export const marker = (upstream: string, id: string, part = 0): string => `<!-- dsh-mirror:${key(upstream)}:${key(id)}:${part} -->`
function fenced(text: string): string {
  const width = (char: string) => Math.max(2, ...[...text.matchAll(new RegExp(`${char}+`, 'g'))].map(match => match[0].length)) + 1
  const backticks = width('`'), tildes = width('~'), fence = backticks <= tildes ? '`'.repeat(backticks) : '~'.repeat(tildes)
  return `${fence}\n${text}\n${fence}`
}

/** Preserve every character without producing active mentions, references, images or closing-keyword side effects. */
export function mirrorBodies(upstream: string, value: RemoteText): string[] {
  const full = 'title' in value && typeof value.title === 'string' ? `${value.title}\n\n${value.body}` : value.body
  const chunks = full.match(/[\s\S]{1,30000}/gu) ?? ['']
  return chunks.map((text, part) => {
    // Even an ordinary upstream link creates a cross-reference on GitHub; keep provenance inert as well.
    return `${marker(upstream, value.id, part)}\n\nMirrored from \`${value.url}\`\n\nOriginal author: [${value.author}](https://github.com/${encodeURIComponent(value.author)}) · Created: ${value.createdAt} · Updated: ${value.updatedAt} · Part ${part + 1}/${chunks.length}\n\n${fenced(text)}`
  })
}
const firstLine = (body: string) => body.split('\n', 1)[0]!

/** Performs a full inventory; markers authored by the mirror account recover writes whose response was lost. */
export async function reconcile(client: ForkGithub, login: string, status: MirrorStatus, save: () => void,
  write: <T>(run: () => Promise<T>) => Promise<T>): Promise<void> {
  for (const kind of ['issue', 'discussion'] as const) {
    const list = (repository: string) => kind === 'issue' ? client.issues(repository) : client.discussions(repository)
    const comments = (repository: string, thread: RemoteThread) => kind === 'issue'
      ? client.issueComments(repository, thread.number) : client.discussionComments(repository, thread.id)
    const source = await list(client.upstream), destination = await list(client.fork)
    const owned = new Map(destination.filter(value => value.author.toLowerCase() === login.toLowerCase()).map(value => [firstLine(value.body), value]))
    for (const item of source) {
      const bodies = mirrorBodies(client.upstream, item)
      const metadata = `Upstream state: ${item.closed ? 'closed' : 'open'}${item.category ? ` · Category: ${item.category}` : ''}${item.labels?.length ? ` · Labels: ${item.labels.join(', ')}` : ''}`
      const body = `${bodies[0]!}\n\n${fenced(metadata)}`
      const title = `[upstream ${kind} #${item.number}] ${item.title}`.replace(/[@#/]/g, '$&\u200b').slice(0, 256)
      let target = owned.get(marker(client.upstream, item.id))
      if (!target) {
        target = await write(() => kind === 'issue' ? client.createIssue(title, body) : client.createDiscussion(title, body, item.category))
        target = { ...target, author: login }; owned.set(marker(client.upstream, item.id), target)
      } else if (target.title !== title || target.body !== body) {
        const current = target
        await write(() => kind === 'issue' ? client.updateIssue(current.number, title, body, current.closed)
          : client.updateDiscussion(current.id, title, body))
      }
      const targetComments = await comments(client.fork, target)
      const byMarker = new Map(targetComments.filter(value => value.author.toLowerCase() === login.toLowerCase()).map(value => [firstLine(value.body), value]))
      const expected = new Set<string>(), parentIds = new Map<string, string>()
      const writePart = async (text: string, parent?: string) => {
        const mark = firstLine(text); expected.add(mark)
        const before = byMarker.get(mark)
        if (before?.body === text) return before
        if (kind === 'discussion' && target!.closed) {
          await write(() => client.discussionState(target!.id, false)); target!.closed = false
        }
        const value = await write(() => kind === 'issue' ? client.writeIssueComment(target!.number, text, before)
          : client.writeDiscussionComment(target!.id, text, parent, before))
        byMarker.set(mark, value)
        return value
      }
      for (const text of bodies.slice(1)) await writePart(text)
      for (const comment of await comments(client.upstream, item)) {
        const parts = mirrorBodies(client.upstream, comment)
        const parent = comment.parent ? parentIds.get(comment.parent) : undefined
        if (comment.parent && !parent) throw new Error('Missing mirrored Discussion parent; refusing to flatten its reply')
        const root = await writePart(parts[0]!, parent)
        parentIds.set(comment.id, root.id)
        for (const part of parts.slice(1)) await writePart(part, kind === 'discussion' ? parent ?? root.id : undefined)
        status.comments++; save()
      }
      const prefix = `<!-- dsh-mirror:${key(client.upstream)}:`
      for (const [mark, previous] of byMarker) {
        if (!mark.startsWith(prefix) || expected.has(mark) || previous.body.includes('\n\n[Removed upstream; retained for history]\n')) continue
        await writePart(`${mark}\n\n[Removed upstream; retained for history]\n${previous.body.slice(mark.length)}`, previous.parent)
      }
      if (target.closed !== item.closed) await write(() => kind === 'issue'
        ? client.updateIssue(target!.number, title, body, item.closed) : client.discussionState(target!.id, item.closed))
      status[kind === 'issue' ? 'issues' : 'discussions']++
      status.recent = [{ title: item.title, upstream: item.url, fork: target.url }, ...status.recent].slice(0, 20)
      save()
    }
  }
}

/** Keeps one durable full-sync schedule, independently of agent execution and without generating domain triggers. */
export async function watchMirror(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) return
  while (!signal.aborted) {
    const config = ctx.config<z.infer<typeof MirrorConfig>>('github-mirror')
    if (!config?.upstream) { ctx.report('github-mirror', { state: 'paused', detail: 'Daily mirroring is disabled' }); await pause(60000, signal); continue }
    const fork = ctx.deployment.repository, upstream = config.upstream
    const before = ctx.state.get(MIRROR_STATUS), binding = ctx.state.get(MIRROR_BINDING)
    if (upstream.toLowerCase() === fork.toLowerCase() || binding && (binding.upstream !== upstream || binding.fork !== fork)) {
      ctx.report('github-mirror', { state: 'error', detail: 'Mirror repository binding changed; refusing writes' }); return
    }
    ctx.state.set(MIRROR_BINDING, { upstream, fork })
    if (before?.nextRunAt && Date.parse(before.nextRunAt) > Date.now()) {
      ctx.report('github-mirror', { state: before.error ? 'error' : 'ready', detail: before.error ?? `Daily sync next: ${before.nextRunAt}; ${before.issues} issues, ${before.discussions} discussions, ${before.comments} comments` })
      await pause(Math.min(60000, Date.parse(before.nextRunAt) - Date.now()), signal); continue
    }
    const status: MirrorStatus = { upstream, fork, phase: 'running', startedAt: new Date().toISOString(),
      lastWriteAt: before?.lastWriteAt, completedAt: before?.completedAt, issues: 0, discussions: 0, comments: 0, changes: 0, recent: [] }
    const save = () => {
      ctx.state.set(MIRROR_STATUS, { ...status, recent: [...status.recent] })
      ctx.report('github-mirror', { state: status.phase === 'error' ? 'error' : 'ready',
        detail: status.error ?? `Full sync: ${status.issues} issues, ${status.discussions} discussions, ${status.comments} comments; ${status.changes} writes` })
    }
    save()
    const client = new ForkGithub(upstream, fork, join(ctx.deployment.stateDir, 'mirror-input'),
      args => ctx.commands.withSignal(signal).run(ctx.deployment.github.cli, args))
    try {
      await reconcile(client, ctx.deployment.github.login, status, save, async run => {
        await pause(Math.max(0, Date.parse(status.lastWriteAt ?? '') + config.writeSeconds * 1000 - Date.now()) || 0, signal)
        signal.throwIfAborted()
        if (!ctx.config('github-mirror')) throw new Error('Mirror disabled during sync')
        status.lastWriteAt = new Date().toISOString(); save()
        const result = await run(); status.changes++; save(); return result
      })
      status.phase = 'idle'; status.completedAt = new Date().toISOString()
      status.nextRunAt = new Date(Math.max(Date.now() + 60000, Date.parse(status.startedAt!) + config.intervalHours * 3600000)).toISOString()
    } catch (error) {
      if (signal.aborted) { save(); return }
      status.phase = 'error'; status.error = error instanceof Error ? error.message : String(error)
      status.nextRunAt = new Date(Date.now() + (/403|429|rate limit/i.test(status.error) ? 3600000 : 60000)).toISOString()
    }
    save()
  }
}
