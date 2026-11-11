/** Explicit human mentions in fork Discussions, with replies delivered back to the same fork conversation. */
import { join } from 'node:path'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { record } from '../kv.ts'
import { ForkGithub, type RemoteText, type RemoteThread } from '../mirror/github.ts'
import { mentions } from './github-trigger.ts'
import { githubKind } from './github.ts'
import type { SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'

export const DISCUSSION_SOURCE = 'github-discussions'
const Config = z.object({ pollSeconds: z.number().int().min(60).max(3600).default(120) }).strict()
const sinceKey = record<string>('github-discussions:since')
const seenKey = (id: string) => record<boolean>(`github-discussions:seen:${id}`)
const clientOf = (ctx: Pick<SourceContext, 'commands'>) => new ForkGithub(ctx.commands.repository, ctx.commands.repository,
  join(ctx.commands.deployment.stateDir, 'discussion-input'), args => ctx.commands.run(ctx.commands.deployment.github.cli, args))

export function discussionTrigger(thread: RemoteThread, comment: RemoteText, login: string, root = false): Trigger {
  const channel = { source: DISCUSSION_SOURCE, thread: `${DISCUSSION_SOURCE}:${thread.number}`,
    address: { number: String(thread.number), id: thread.id, url: comment.url,
      ...root ? {} : { parent: comment.parent ?? comment.id } } }
  return { id: key(DISCUSSION_SOURCE, comment.id), source: DISCUSSION_SOURCE,
    threads: [{ source: DISCUSSION_SOURCE, id: String(thread.number) }],
    actor: { source: DISCUSSION_SOURCE, id: comment.author },
    human: comment.author.toLowerCase() !== login.toLowerCase() && !comment.author.endsWith('[bot]'),
    ...mentions(comment.body, login) ? { addressed: 'mention' as const } : {},
    text: root ? `${thread.title}\n\n${comment.body}` : comment.body, at: comment.createdAt, url: comment.url, channel,
    meta: { number: thread.number, discussionId: thread.id, commentId: comment.id, createdAt: comment.createdAt } }
}

export const discussionKind: SourceKind<z.infer<typeof Config>> = {
  kind: DISCUSSION_SOURCE, title: { zh: 'GitHub Discussions', en: 'GitHub Discussions' },
  description: { zh: '只接收当前 fork 中新发的人工 @；同步账号的内容不会触发执行。', en: 'New human mentions in the configured fork only; mirrored bot content never starts work.' },
  schema: Config, health: [DISCUSSION_SOURCE],
  fields: [{ key: 'pollSeconds', type: 'number', min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Poll interval / seconds' } }],
  scope: () => ({ listened: true, observed: false }),
  policy: { schema: githubKind.policy!.schema, fields: [githubKind.policy!.fields[0]!],
    explicit: { zh: '白名单用户在 fork 的 Discussion 或回复中明确 @ 智能体。', en: 'An allowlisted person explicitly mentions the agent in a fork Discussion or reply.' } },
  channel: {
    link: (address, links) => ({ url: address.url ?? (links.repository ? `https://github.com/${links.repository}/discussions/${address.number}` : ''),
      label: { zh: `Discussion #${address.number}`, en: `Discussion #${address.number}` } }),
    send: async (ctx, message) => {
      const client = clientOf(ctx), number = Number(message.channel.address.number)
      const thread = (await client.discussions(client.fork)).find(value => value.number === number)
      if (!thread || thread.id !== message.channel.address.id) throw new Error('Discussion reply target is missing or changed')
      const comments = await client.discussionComments(client.fork, thread.id)
      const mark = `<!-- dsh-superagent:${message.id} -->`, login = ctx.commands.deployment.github.login
      if (comments.some(value => value.author.toLowerCase() === login.toLowerCase() && value.body.includes(mark))) return 'sent'
      const parent = comments.find(value => value.id === message.channel.address.parent)
      await client.writeDiscussionComment(thread.id, `${message.text}\n\n${mark}`, parent ? parent.parent ?? parent.id : undefined)
      return 'sent'
    },
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.commentId),
    read: async (commands, trigger, part, cursor) => {
      const client = clientOf({ commands }), thread = (await client.discussions(client.fork)).find(value => value.number === trigger.meta.number)
      if (!thread) throw new Error('Discussion not found in the fork')
      const all = part === 'root' ? [thread] : [thread, ...await client.discussionComments(client.fork, thread.id)]
      const offset = Number(cursor ?? 0)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid Discussion context cursor')
      return { messages: all.slice(offset, offset + 50).map(value => ({ id: value.id, from: value.author, text: value.body,
        at: value.createdAt, url: value.url, ...value.author.toLowerCase() === commands.deployment.github.login.toLowerCase()
          || value.author.endsWith('[bot]') ? { bot: true as const } : {} })),
      ...offset + 50 < all.length ? { next: String(offset + 50) } : {}, body: { title: thread.title, url: thread.url, number: thread.number } }
    },
  },
}

/** Polls only for newly authored mentions; the activation baseline and delivery receipts survive restarts. */
export async function watchDiscussions(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) return
  while (!signal.aborted) {
    const config = ctx.config<z.infer<typeof Config>>(DISCUSSION_SOURCE)
    if (!config) { ctx.report(DISCUSSION_SOURCE, { state: 'paused', detail: 'Off' }); await pause(60000, signal); continue }
    const since = ctx.state.get(sinceKey) ?? new Date().toISOString()
    ctx.state.set(sinceKey, since)
    try {
      const commands = ctx.commands.withSignal(signal), client = clientOf({ commands }), login = ctx.deployment.github.login
      const receive = async (thread: RemoteThread, text: RemoteText, root = false) => {
        signal.throwIfAborted()
        if (!ctx.config(DISCUSSION_SOURCE) || Date.parse(text.createdAt) < Date.parse(since)
          || text.author.toLowerCase() === login.toLowerCase() || text.author.endsWith('[bot]')
          || !mentions(text.body, login) || ctx.state.get(seenKey(text.id))) return
        await ctx.receive(discussionTrigger(thread, text, login, root))
        ctx.state.set(seenKey(text.id), true)
        ctx.threads.describe(`${DISCUSSION_SOURCE}:${thread.number}`, { label: thread.title, url: thread.url })
      }
      for (const thread of await client.discussions(client.fork)) {
        await receive(thread, thread, true)
        for (const comment of await client.discussionComments(client.fork, thread.id)) await receive(thread, comment)
      }
      ctx.report(DISCUSSION_SOURCE, { state: 'ready', detail: 'Fork-only explicit mentions; mirror account ignored' })
    } catch (error) {
      if (!signal.aborted) ctx.report(DISCUSSION_SOURCE, { state: 'error', detail: error instanceof Error ? error.message : String(error) })
    }
    await pause(config.pollSeconds * 1000, signal)
  }
}
