/** Durable worker routing; existing tickets keep their backend when the default changes. */
import type { Assignment, AssessmentOutcome, Executor, Ticket } from '../core/index.ts'
import { DshExecutor, WorkerSlots, type ExecutorHost } from './dsh.ts'
import { CopilotExecutor, type CopilotHost } from './copilot.ts'

export interface WorkerBackend {
  launchQueued(payload: { ticketId: string; assignmentId: string }): Promise<void>
  deliverQueued(ticketId: string): Promise<void>
  running(ticket: Ticket): boolean
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
  install(): void
  resume(): void
  shutdown(): Promise<void>
  dispose(): void
}
/** Owns the effect handlers and shared capacity for registered worker backends. */
export class WorkerExecutors implements Executor {
  private readonly backends: Record<'dsh' | 'copilot', WorkerBackend>
  private readonly dsh: DshExecutor
  readonly copilot: CopilotExecutor
  private readonly slots: WorkerSlots
  constructor(private readonly host: ExecutorHost, external: Omit<CopilotHost, keyof ExecutorHost | 'prepareDirectory'>) {
    this.slots = new WorkerSlots(() => host.store.tickets.list().filter(ticket => this.backend(ticket).running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers)
    this.dsh = new DshExecutor(host, { slots: this.slots, effects: false })
    // Keep host getters lazy: Runtime constructs Engine after constructing its executor.
    const copilotHost = Object.assign(Object.create(host) as CopilotHost, external,
      { prepareDirectory: (ticket: Ticket) => this.dsh.prepareDirectory(ticket) })
    this.copilot = new CopilotExecutor(copilotHost, this.slots)
    this.backends = { dsh: this.dsh, copilot: this.copilot }
    host.effects.handle('launch', async payload => this.backendOf(payload.ticketId)?.launchQueued(payload), {
      limit: () => host.paused() ? 0 : this.slots.launches(), retry: [5000, 300_000] })
    host.effects.handle('delivery', async payload => this.backendOf(payload.ticketId)?.deliverQueued(payload.ticketId), {
      limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  private backend(ticket: Ticket): WorkerBackend { return this.backends[ticket.execution?.backend ?? 'dsh'] }
  private backendOf(id: string): WorkerBackend | undefined {
    const ticket = this.host.store.tickets.get(id)
    return ticket && this.backend(ticket)
  }
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    const prepared = this.dsh.prepare(ticket, outcome)
    if (this.host.store.settings().executor.backend === 'copilot') prepared.execution!.backend = 'copilot'
    return prepared
  }
  start(ticket: Ticket, assignment: Assignment): void { this.dsh.start(ticket, assignment) }
  deliver(ticket: Ticket, assignment: Assignment): void { this.dsh.deliver(ticket, assignment) }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void { this.backend(ticket).stop(ticket, assignment, reason) }
  activeCount(): number { return this.slots.used() }
  install(): void { for (const backend of Object.values(this.backends)) backend.install() }
  resume(): void { for (const backend of Object.values(this.backends)) backend.resume() }
  async shutdown(): Promise<void> { await Promise.all(Object.values(this.backends).map(backend => backend.shutdown())) }
  dispose(): void { for (const backend of Object.values(this.backends)) backend.dispose() }
}
