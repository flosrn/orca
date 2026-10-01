import type { LifecycleFile, PreparationDeletionObligation } from './preparation-lifecycle-file'

export function generationRevoked(state: LifecycleFile, host: string, instanceId: string): boolean {
  return state.deletionObligations.some(
    (entry) => entry.host === host && entry.instanceId === instanceId
  )
}

export function listDeletionObligations(state: LifecycleFile): PreparationDeletionObligation[] {
  return state.deletionObligations.map((entry) => ({ ...entry }))
}

/** Called only after the canonical worktree generation was successfully deleted. */
export function markGenerationDeleted(
  state: LifecycleFile,
  generation: { host: string; instanceId: string },
  recordedAt: number
): void {
  if (generationRevoked(state, generation.host, generation.instanceId)) {
    return
  }
  state.deletionObligations.push({ ...generation, recordedAt })
}

/** Drops the generation's records and obligation once its archives are gone. */
export function markGenerationPurged(
  state: LifecycleFile,
  generation: { host: string; instanceId: string }
): void {
  state.records = state.records.filter(
    (record) => record.host !== generation.host || record.instanceId !== generation.instanceId
  )
  state.deletionObligations = state.deletionObligations.filter(
    (entry) => entry.host !== generation.host || entry.instanceId !== generation.instanceId
  )
}
