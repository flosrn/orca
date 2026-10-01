import type { WorktreeIdentity } from './worktree/identity'

/** Opaque creation-scoped identity the managing runtime issues before any preparation command can run. */
export type PreparationRegistration = { preparationId: string }

export type PreparationPaneRole = 'preparation' | 'agent'

/** Carried on a spawn so the acknowledged incarnation binds to exactly one registration role. */
export type PreparationSpawnIntake = PreparationRegistration & { role: PreparationPaneRole }

/** Exact pane incarnation acknowledged by a spawn; never selected by title or path. */
export type PreparationPaneBinding = {
  handle: string
  ptyId: string
  incarnationId: string | null
  tabId: string | null
  leafId: string | null
  paneKey: string | null
}

export type PreparationRecord = {
  preparationId: string
  worktree: WorktreeIdentity
  registeredAt: number
  preparation: PreparationPaneBinding | null
  agent: PreparationPaneBinding | null
}

export type PreparationRecordFilter = { worktreeKey?: string }

export function isPreparationSpawnIntake(value: unknown): value is PreparationSpawnIntake {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate: { preparationId?: unknown; role?: unknown } = value
  return (
    typeof candidate.preparationId === 'string' &&
    candidate.preparationId.length > 0 &&
    (candidate.role === 'preparation' || candidate.role === 'agent')
  )
}

export function preparationSpawnIntake(
  registration: PreparationRegistration | undefined,
  role: PreparationPaneRole
): { preparation: PreparationSpawnIntake } | Record<string, never> {
  return registration ? { preparation: { preparationId: registration.preparationId, role } } : {}
}
