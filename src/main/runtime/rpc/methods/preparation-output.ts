import { defineMethod } from '../core'
import {
  PreparationOutputListParams,
  PreparationOutputReadParams
} from '../../../../shared/rpc-contract/preparation-output-params'
import type {
  PreparationOutputListResult,
  PreparationOutputPage
} from '../../../../shared/preparation-output-read'
import { canonicalWorktreeIdentity } from '../../../../shared/worktree/identity'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { PreparationOutputStore } from '../../preparation/preparation-output-store'

// Why: reads address committed archives only; no PTY, setup command or live terminal is touched.
function requireStore(runtime: OrcaRuntimeService): PreparationOutputStore {
  const store = runtime.getPreparationOutputStore()
  if (!store) {
    throw new Error('preparation_output_storage_unavailable')
  }
  return store
}

export const PREPARATION_OUTPUT_METHODS = [
  defineMethod({
    name: 'preparation.output.list',
    params: PreparationOutputListParams,
    handler: async (params, { runtime }): Promise<PreparationOutputListResult> => {
      const worktree = await runtime.showManagedWorktree(params.worktree)
      if (!worktree.hostId || !worktree.instanceId) {
        throw new Error('preparation_output_worktree_identity_unavailable')
      }
      const worktreeKey = canonicalWorktreeIdentity({
        worktreeId: worktree.id,
        executionHostId: worktree.hostId,
        instanceId: worktree.instanceId
      })
      return {
        worktree: {
          worktreeId: worktree.id,
          hostId: worktree.hostId,
          instanceId: worktree.instanceId,
          worktreeKey
        },
        archives: requireStore(runtime).list({ host: worktree.hostId, worktreeKey })
      }
    }
  }),
  defineMethod({
    name: 'preparation.output.read',
    params: PreparationOutputReadParams,
    handler: async (params, { runtime }): Promise<PreparationOutputPage> =>
      requireStore(runtime).read({
        archiveId: params.archiveId,
        offset: params.offset,
        limit: params.limit
      })
  })
]
