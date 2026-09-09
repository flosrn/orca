import type { DispatchContextRow } from './orchestration/types'

export type DispatchObsoleteRestoreLookup = {
  getLatestDispatchForTerminal(handle: string): DispatchContextRow | undefined
  getActiveDispatchForTerminal(handle: string, paneKey?: string): DispatchContextRow | undefined
  getDispatchContext(taskId: string): DispatchContextRow | undefined
}

/**
 * Proven same-task replacement, the predicate `abandonWorkerDispatch` already
 * calls `stale` (`getDispatchContext(task_id)?.id !== dispatchId`).
 *
 * A completed dispatch that is still the task's latest is not this — the
 * operator may legitimately reopen that pane as a shell. A handle-less or
 * pane-less lookup that returns no row is an operator pane, not a worker.
 * A lookup that throws is unknown and must refuse the relaunch.
 */
export function isDispatchSessionProvenSuperseded(
  db: DispatchObsoleteRestoreLookup,
  expectedHandle: string,
  paneKey: string
): boolean {
  const prior =
    db.getLatestDispatchForTerminal(expectedHandle) ??
    db.getActiveDispatchForTerminal(expectedHandle, paneKey)
  if (!prior) {
    return false
  }
  return db.getDispatchContext(prior.task_id)?.id !== prior.id
}

export function refuseObsoleteDispatchSessionRestore(
  db: DispatchObsoleteRestoreLookup | null | undefined,
  expectedHandle: string,
  paneKey: string
): void {
  // No orchestration DB is an operator pane, not an unknown read.
  if (!db) {
    return
  }
  let superseded: boolean
  try {
    superseded = isDispatchSessionProvenSuperseded(db, expectedHandle, paneKey)
  } catch {
    throw new Error('terminal_not_recoverable')
  }
  if (superseded) {
    throw new Error('terminal_not_recoverable')
  }
}
