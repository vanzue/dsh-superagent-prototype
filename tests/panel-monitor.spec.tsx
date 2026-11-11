// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { usePanel, mount, click, type, text, field, all } from './fixtures/panel.tsx'
import type { MonitorView } from '../src/monitor/model.ts'

usePanel()
it('renders and filters read-only data without mounting execution controls or requesting execution APIs', async () => {
  const at = '2026-11-10T12:00:00.000Z'
  const view: MonitorView = { mode: 'monitor', repository: 'microsoft/intelligent-terminal', pollSeconds: 900, refreshing: false,
    snapshot: { repository: 'microsoft/intelligent-terminal', defaultBranch: 'main', syncedAt: at, since: at, warnings: ['Partial event history'],
      issues: [{ number: 1, title: 'Terminal bug', author: 'alice', labels: ['bug'], url: 'https://github.com/microsoft/intelligent-terminal/issues/1',
        updatedAt: at, state: 'open', draft: false }], pulls: [], activity: [{ id: 'c1', kind: 'comment', title: '@bot please fix this now',
        actor: 'alice', url: 'https://github.com/microsoft/intelligent-terminal/issues/1', at }], runs: [] } }
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    requests.push(`${options.method} ${url}`)
    expect(options.method).toBe('GET')
    if (url === '/orchestrator/api/mode') return new Response(JSON.stringify({ mode: 'monitor' }))
    if (url === '/orchestrator/api/monitor') return new Response(JSON.stringify(view))
    throw new Error(`Unexpected execution API: ${url}`)
  }))
  await mount(en)
  expect(text()).toContain('Terminal bug')
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['Open issues', 'Open PRs', 'Last 7 days', 'CI runs', 'Permissions & sync'])
  expect(all('button').some(button => /Resume processing|Open main Session|Retry/.test(button.textContent ?? ''))).toBe(false)
  await type(field<HTMLInputElement>(en['monitor.search']), 'missing')
  expect(text()).not.toContain('Terminal bug')
  await type(field<HTMLInputElement>(en['monitor.search']), '')
  await click('Last 7 days')
  expect(text()).toContain('@bot please fix this now')
  await click('Permissions & sync')
  expect(text()).toContain('Anonymous public-repository reads')
  await click('Refresh view')
  expect(new Set(requests)).toEqual(new Set(['GET /orchestrator/api/mode', 'GET /orchestrator/api/monitor']))
})
