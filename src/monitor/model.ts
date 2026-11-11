/** Persisted, repository-scoped read models for the credential-free monitoring dashboard. */
import { z } from 'zod'

export const MonitorConfig = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .refine(value => value.split('/').every(part => part !== '.' && part !== '..')),
  pollSeconds: z.number().int().min(300).max(86400).default(900),
})
const Item = z.object({
  number: z.number(), title: z.string(), url: z.string(), author: z.string(), updatedAt: z.string(),
  labels: z.array(z.string()), draft: z.boolean(), state: z.string(),
})
const Activity = z.object({
  id: z.string(), kind: z.string(), title: z.string(), url: z.string(), actor: z.string(), at: z.string(),
})
const Run = z.object({
  id: z.number(), title: z.string(), url: z.string(), branch: z.string(), status: z.string(),
  conclusion: z.string(), at: z.string(), pulls: z.array(z.number()),
})
export const Snapshot = z.object({
  repository: z.string(), defaultBranch: z.string(), syncedAt: z.string(), since: z.string(),
  issues: z.array(Item), pulls: z.array(Item), activity: z.array(Activity), runs: z.array(Run),
  warnings: z.array(z.string()),
})
export const MonitorSchedule = z.object({
  repository: z.string(), nextSync: z.iso.datetime(), remaining: z.number().optional(), resetAt: z.iso.datetime().optional(),
  retryAt: z.number(), lastAttempt: z.iso.datetime().optional(), error: z.string().optional(),
})
export type MonitorItem = z.infer<typeof Item>
export type MonitorActivity = z.infer<typeof Activity>
export type MonitorSnapshot = z.infer<typeof Snapshot>
export interface MonitorView {
  mode: 'monitor'
  repository: string
  pollSeconds: number
  refreshing: boolean
  lastAttempt?: string
  nextSync?: string
  error?: string
  remaining?: number
  resetAt?: string
  snapshot?: MonitorSnapshot
}
