/** Credential-free repository dashboard: cached snapshots only, without execution or settings controls. */
import { useState } from 'react'
import { usePoll, type Call } from './api.ts'
import { Button, Input, SegmentedTabs } from './controls.tsx'
import type { T } from './text.ts'
import { Section } from './widgets.tsx'
import type { MonitorItem } from '../monitor/model.ts'

const TABS = ['issues', 'pulls', 'activity', 'ci', 'permissions'] as const
type Tab = typeof TABS[number]

export function MonitorDashboard({ t, call }: { t: T; call: Call }) {
  const { data, error, reload } = usePoll(() => call('GET monitor'), [call], 10000)
  const [tab, setTab] = useState<Tab>('issues')
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(50)
  const time = (at?: string) => at ? new Date(at).toLocaleString(t('lang') === 'zh' ? 'zh-CN' : 'en-US') : t('empty')
  const snapshot = data?.snapshot
  const matches = (value: string) => value.toLowerCase().includes(query.trim().toLowerCase())
  const items = (tab === 'pulls' ? snapshot?.pulls : snapshot?.issues)?.filter(value =>
    matches([value.number, value.title, value.author, ...value.labels].join(' '))) ?? []
  const activity = snapshot?.activity.filter(value => matches([value.kind, value.title, value.actor].join(' '))) ?? []
  const runs = snapshot?.runs.filter(value => matches([value.title, value.branch, value.status, value.conclusion,
    ...value.pulls.map(number => `#${number}`)].join(' '))) ?? []
  const total = tab === 'activity' ? activity.length : tab === 'ci' ? runs.length : items.length
  const link = (url: string, title: string) => <a className="dt-open dt-open-wrap" href={url} target="_blank" rel="noopener noreferrer">{title}</a>
  const stat = (label: string, value: number | undefined) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span><span className="dt-stat-value">{value ?? t('empty')}</span>
  </span>
  const row = (value: MonitorItem) => <li className="dt-row" key={value.number}><div className="dt-row-main">
    <div className="dt-row-title">{link(value.url, `#${value.number} ${value.title}`)}</div>
    <div className="dt-row-meta"><span>{value.author}</span><time dateTime={value.updatedAt}>{time(value.updatedAt)}</time>
      {value.draft && <span className="dt-tag" data-tone="neutral">{t('monitor.draft')}</span>}
      {value.labels.map(label => <span className="dt-tag" data-tone="outline" key={label}>{label}</span>)}</div>
  </div></li>
  return <div className="dt-page"><div className="dt-column">
    <header className="dt-head"><div className="dt-head-title"><h1 className="dt-title">{t('monitor.title')}</h1>
      <span className="dt-tag" data-tone="success">{t('monitor.readonly')}</span></div>
      <Button variant="outline" onClick={() => { void reload() }}>{t('monitor.refreshView')}</Button>
    </header>
    <main className="dt-main">
      <Section title={data?.repository ?? t('loading')}>
        <p className="dt-hint">{t('monitor.policy')}</p>
        <div className="dt-stats">
          {stat(t('monitor.issues'), snapshot?.issues.length)}
          {stat(t('monitor.pulls'), snapshot?.pulls.length)}
          {stat(t('monitor.activity'), snapshot?.activity.length)}
          {stat(t('monitor.failedRuns'), snapshot?.runs.filter(run => ['failure', 'timed_out', 'action_required'].includes(run.conclusion)).length)}
        </div>
        <p className="dt-hint" role="status">{t('monitor.sync', { last: time(snapshot?.syncedAt), next: time(data?.nextSync) })}
          {data?.refreshing && ` ${t('monitor.syncing')}`}</p>
        {(error || data?.error) && <p className="dt-error" role="alert">{error?.message ?? data?.error}</p>}
        {!snapshot && <p className="dt-hint">{t('monitor.firstSync')}</p>}
      </Section>
      <SegmentedTabs label={t('pagesLabel')} value={tab} onChange={value => { setTab(value); setShown(50) }}
        items={TABS.map(value => ({ value, label: t(`monitor.${value}`), id: `monitor-tab-${value}`, panelId: 'monitor-content' }))} />
      <div id="monitor-content" role="tabpanel" aria-labelledby={`monitor-tab-${tab}`}>
        {tab === 'permissions' ? <Section title={t('monitor.permissions')}>
          <p>{t('monitor.credentials')}</p><p>{t('monitor.policy')}</p><p>{t('monitor.isolation')}</p>
          <p className="dt-hint">{t('monitor.rate', { remaining: data?.remaining ?? t('empty'), reset: time(data?.resetAt),
            minutes: (data?.pollSeconds ?? 900) / 60 })}</p>
          <p className="dt-hint">{t('monitor.boundary')}</p>
        </Section> : <Section title={t(`monitor.${tab}`)} count={total}>
          <Input type="search" value={query} aria-label={t('monitor.search')} placeholder={t('monitor.search')}
            onChange={event => { setQuery(event.target.value); setShown(50) }} />
          {tab === 'activity' && <p className="dt-hint">{t('monitor.activityScope', { since: time(snapshot?.since) })}</p>}
          {tab === 'ci' && <p className="dt-hint">{t('monitor.ciScope')}</p>}
          {!total && <p className="dt-hint">{snapshot ? t('none') : t('loading')}</p>}
          <ul className="dt-list">
            {(tab === 'issues' || tab === 'pulls') && items.slice(0, shown).map(row)}
            {tab === 'activity' && activity.slice(0, shown).map(value => <li className="dt-row" key={value.id}><div className="dt-row-main">
              <div className="dt-row-title">{link(value.url, value.title || value.kind)}</div>
              <div className="dt-row-meta"><span>{value.kind}</span><span>{value.actor}</span><time dateTime={value.at}>{time(value.at)}</time></div>
            </div></li>)}
            {tab === 'ci' && runs.slice(0, shown).map(value => <li className="dt-row" key={value.id}><div className="dt-row-main">
              <div className="dt-row-title">{link(value.url, value.title)}</div>
              <div className="dt-row-meta"><span className="dt-tag" data-tone={value.conclusion === 'success' ? 'success'
                : ['failure', 'timed_out', 'action_required'].includes(value.conclusion) ? 'danger' : 'neutral'}>{value.conclusion || value.status}</span>
                <span>{value.branch}</span><span>{value.pulls.map(number => `#${number}`).join(', ')}</span>
                <time dateTime={value.at}>{time(value.at)}</time></div>
            </div></li>)}
          </ul>
          {shown < total && <Button variant="outline" onClick={() => setShown(value => value + 50)}>{t('loadMore')}</Button>}
        </Section>}
      </div>
      <Section title={t('monitor.coverage')}>
        <p className="dt-hint">{t('monitor.coverageHint')}</p>
        {snapshot?.warnings.map((warning, index) => <p className="dt-hint" key={index}>{warning}</p>)}
      </Section>
    </main>
  </div></div>
}
