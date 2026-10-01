import { isRecord } from './agent-status-child-work-value-guards'

/** Root readiness fact an OMP status extension adds to its status posts. */
export type PreparationRootReadiness = {
  root_session_ready: true
  root_session_id: string
  status_owner_module: string
}

/** Returns the receipt only when every field is present and well-formed. */
export function readPreparationRootReadiness(record: unknown): PreparationRootReadiness | null {
  if (!isRecord(record)) {
    return null
  }
  if (
    record.root_session_ready !== true ||
    typeof record.root_session_id !== 'string' ||
    record.root_session_id.length === 0 ||
    typeof record.status_owner_module !== 'string' ||
    record.status_owner_module.length === 0
  ) {
    return null
  }
  return {
    root_session_ready: true,
    root_session_id: record.root_session_id,
    status_owner_module: record.status_owner_module
  }
}
