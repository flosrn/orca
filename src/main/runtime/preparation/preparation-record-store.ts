import { randomUUID } from 'node:crypto'
import type {
  PreparationPaneBinding,
  PreparationPaneRole,
  PreparationRecord,
  PreparationRecordFilter,
  PreparationRegistration,
  PreparationSpawnIntake
} from '../../../shared/preparation-contracts'
import type { WorktreeIdentity } from '../../../shared/worktree/identity'

/** Pre-spawn claim on a pane key, armed before the provider can emit a first byte. */
export type PreparationPaneReservation = {
  handle: string
  tabId: string | null
  leafId: string | null
}

export type PreparationRecordEvent =
  | { kind: 'registered'; record: PreparationRecord }
  | { kind: 'bound'; record: PreparationRecord; role: PreparationPaneRole }

type Entry = {
  preparationId: string
  worktree: WorktreeIdentity
  // Why: spawns name their workspace by locator; binding refuses a spawn from another checkout.
  worktreeLocator: string
  registeredAt: number
  bindings: Record<PreparationPaneRole, PreparationPaneBinding | null>
  reservations: Record<PreparationPaneRole, PreparationPaneReservation | null>
}

/**
 * Creation-scoped preparation registrations owned by the managing runtime.
 * A role binds to the first acknowledged incarnation only; a replay of that same incarnation
 * reattaches, a different incarnation never inherits the registration.
 */
export class PreparationRecordStore {
  private readonly entries = new Map<string, Entry>()
  /** Bound pane pty id → its registration. A pty binds one role of one preparation. */
  private readonly byPtyId = new Map<string, string>()
  private pendingReservations = 0
  private readonly listeners = new Set<(event: PreparationRecordEvent) => void>()

  /** Observes first registrations and first binds; listener failures never affect creation. */
  onChange(listener: (event: PreparationRecordEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** True while a preparation pane is armed but its spawn has not been acknowledged or released. */
  hasPendingReservation(): boolean {
    return this.pendingReservations > 0
  }

  get(preparationId: string): PreparationRecord | null {
    const entry = this.entries.get(preparationId)
    return entry ? snapshot(entry) : null
  }

  findByPtyId(ptyId: string): { record: PreparationRecord; role: PreparationPaneRole } | null {
    const preparationId = this.byPtyId.get(ptyId)
    const entry = preparationId ? this.entries.get(preparationId) : undefined
    if (!entry) {
      return null
    }
    for (const role of ['preparation', 'agent'] as const) {
      if (entry.bindings[role]?.ptyId === ptyId) {
        return { record: snapshot(entry), role }
      }
    }
    this.byPtyId.delete(ptyId)
    return null
  }

  register(worktree: WorktreeIdentity, worktreeLocator: string): PreparationRegistration {
    const preparationId = randomUUID()
    this.entries.set(preparationId, {
      preparationId,
      worktree: { ...worktree },
      worktreeLocator,
      registeredAt: Date.now(),
      bindings: { preparation: null, agent: null },
      reservations: { preparation: null, agent: null }
    })
    const entry = this.entries.get(preparationId)
    if (entry) {
      this.emit({ kind: 'registered', record: snapshot(entry) })
    }
    return { preparationId }
  }

  list(filter: PreparationRecordFilter = {}): PreparationRecord[] {
    const records: PreparationRecord[] = []
    for (const entry of this.entries.values()) {
      if (filter.worktreeKey === undefined || entry.worktree.key === filter.worktreeKey) {
        records.push(snapshot(entry))
      }
    }
    return records
  }

  /** Arms the pane key before spawn; refuses unknown registrations, foreign worktrees and bound roles. */
  reserve(
    intake: PreparationSpawnIntake,
    worktreeLocator: string,
    reservation: PreparationPaneReservation
  ): boolean {
    const entry = this.entries.get(intake.preparationId)
    if (!entry || entry.worktreeLocator !== worktreeLocator || entry.bindings[intake.role]) {
      return false
    }
    entry.reservations[intake.role] = { ...reservation }
    this.pendingReservations += 1
    return true
  }

  /** Drops a reservation whose spawn never produced an acknowledged incarnation. */
  releaseReservation(intake: PreparationSpawnIntake, handle: string): void {
    const entry = this.entries.get(intake.preparationId)
    if (entry?.reservations[intake.role]?.handle === handle) {
      entry.reservations[intake.role] = null
      this.pendingReservations -= 1
    }
  }

  /** Binds the acknowledged incarnation. True when bound now or when it is the same incarnation. */
  bind(
    intake: PreparationSpawnIntake,
    worktreeLocator: string,
    binding: PreparationPaneBinding
  ): boolean {
    const entry = this.entries.get(intake.preparationId)
    if (!entry || entry.worktreeLocator !== worktreeLocator) {
      return false
    }
    const existing = entry.bindings[intake.role]
    if (existing) {
      return existing.ptyId === binding.ptyId && existing.incarnationId === binding.incarnationId
    }
    const otherRole: PreparationPaneRole = intake.role === 'agent' ? 'preparation' : 'agent'
    if (entry.bindings[otherRole]?.ptyId === binding.ptyId) {
      return false
    }
    if (entry.reservations[intake.role]) {
      entry.reservations[intake.role] = null
      this.pendingReservations -= 1
    }
    entry.bindings[intake.role] = { ...binding }
    this.byPtyId.set(binding.ptyId, entry.preparationId)
    this.emit({ kind: 'bound', record: snapshot(entry), role: intake.role })
    return true
  }

  private emit(event: PreparationRecordEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[preparation] record listener failed:', error)
      }
    }
  }
}

function snapshot(entry: Entry): PreparationRecord {
  return {
    preparationId: entry.preparationId,
    worktree: { ...entry.worktree },
    registeredAt: entry.registeredAt,
    preparation: entry.bindings.preparation ? { ...entry.bindings.preparation } : null,
    agent: entry.bindings.agent ? { ...entry.bindings.agent } : null
  }
}
