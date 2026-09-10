import type { WorkerDispatchRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

/**
 * A start that dies before its authority is bound never filled the Dispatch context in, and
 * release re-proves identity through it — so the custody row written at terminal creation would
 * name a pane no release path could match. Copy that identity across.
 *
 * This grants nothing: it runs only while the Dispatch has no assignee, and only when its
 * capability either was never minted or is already revoked — `failWorkerStart` revokes in the
 * same transaction. An argv start mints its capability before the pane exists, so demanding
 * `capability_hash IS NULL` would leave every failed argv start's terminal unclosable, against
 * the receipt that tells the coordinator to close it with `worker-release`.
 *
 * No transaction: composes inside `failWorkerStart`'s.
 */
export function recordFailedStartDispatchIdentity(
  db: OrchestrationDb,
  worker: WorkerDispatchRow
): void {
  const resource = db.getWorkerTerminalResourceByOwner(worker.dispatch_id)
  if (!resource || resource.terminal_handle !== worker.agent_terminal_handle) {
    return
  }
  db.db
    .prepare(
      `UPDATE dispatch_contexts
         SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ?, host_scope = ?
       WHERE id = ? AND status = 'failed' AND assignee_pane_key IS NULL
         AND (capability_hash IS NULL OR capability_revoked_at IS NOT NULL)`
    )
    .run(
      resource.terminal_handle,
      resource.pane_key,
      resource.process_incarnation,
      resource.host_scope,
      worker.dispatch_id
    )
}
