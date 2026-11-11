/** Optional fork-workflow plugin: deterministic daily mirror plus human-only Discussion intake. */
import type { Context } from '@deepseek-ai/cordis'
import { MirrorConfig, watchMirror } from '../mirror/sync.ts'
import { discussionKind, watchDiscussions } from './discussions.ts'
import { sourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const mirrorKind: SourceKind = {
  kind: 'github-mirror', title: { zh: '上游每日镜像', en: 'Daily upstream mirror' },
  description: { zh: '完整对账上游 Issues、Discussions 和评论，只写入当前 fork，不调用模型。', en: 'Full daily reconciliation of upstream Issues, Discussions and comments into the fork, without model calls.' },
  schema: MirrorConfig, health: ['github-mirror'],
  fields: [
    { key: 'upstream', type: 'text', label: { zh: '只读上游 owner/name', en: 'Read-only upstream owner/name' } },
    { key: 'intervalHours', type: 'number', min: 24, max: 168, label: { zh: '完整对账间隔 / 小时', en: 'Full reconciliation interval / hours' } },
    { key: 'writeSeconds', type: 'number', min: 10, max: 120, label: { zh: '写入间隔 / 秒', en: 'Write interval / seconds' } },
  ],
}
export const name = 'dsh-superagent-fork'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  for (const [kind, watch] of [[mirrorKind, watchMirror], [discussionKind, watchDiscussions]] as const) {
    ctx.effect(() => ctx.orchestrator.sources.register(kind))
    ctx.effect(() => {
      const source = sourceContext(ctx.orchestrator, kind), controller = new AbortController()
      const running = watch(source, controller.signal).catch(error => {
        if (!controller.signal.aborted) source.report(kind.health[0]!, { state: 'error', detail: String(error) })
      })
      return async () => { controller.abort(); await running }
    })
  }
}
