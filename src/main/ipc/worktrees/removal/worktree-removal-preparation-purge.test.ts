import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorktreeIdentity } from '../../../../shared/worktree/identity'
import { PreparationOutputRuntime } from '../../../runtime/preparation/preparation-output-runtime'
import { PreparationRecordStore } from '../../../runtime/preparation/preparation-record-store'
import type { Store } from '../../../persistence/loading-store/store'
import { removeWorktreeMetadataAndTransientState } from './worktree-removal-ownership'

vi.mock('../../pty', () => ({
  getSshPtyProvider: vi.fn(),
  getLocalPtyProvider: vi.fn(),
  clearProviderPtyState: vi.fn()
}))
vi.mock('../../../runtime/worktree-teardown', () => ({ killAllProcessesForWorktree: vi.fn() }))
vi.mock('../../../worktree-removal-repo-owner', () => ({
  hasWorktreeRemovalRepoOwnerOnOtherHost: vi.fn(() => false)
}))
vi.mock('../../../ports/advertised-url-watcher', () => ({
  advertisedUrlWatcher: { forgetWorktree: vi.fn() }
}))
vi.mock('../../../localhost-worktree-label-proxy', () => ({
  localhostWorktreeLabelProxy: { unregisterWorktree: vi.fn() }
}))
vi.mock('../../../terminal-history-deletion', () => ({ deleteWorktreeHistoryDir: vi.fn() }))
vi.mock('../../../github/pr-refresh-coordinator', () => ({
  pruneWorktreePRRefreshAliases: vi.fn()
}))
vi.mock('../../../workspace-cleanup-removal-snapshot-prune', () => ({
  recordWorkspaceCleanupRemovalSnapshotPrune: vi.fn()
}))
vi.mock('../../../workspace-cleanup-scan-snapshot', () => ({
  pruneWorkspaceCleanupScanSnapshot: vi.fn(async () => {})
}))
vi.mock('../../../workspace-space-analysis-snapshot', () => ({
  pruneWorkspaceSpaceAnalysisSnapshot: vi.fn(async () => {})
}))

const WORKTREE_ID = 'repo-1::/tmp/workspaces/reused-path'
const directories: string[] = []
const runtimes: PreparationOutputRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function archivedGeneration(
  output: PreparationOutputRuntime,
  records: PreparationRecordStore,
  host: 'local' | 'ssh:build-box',
  instanceId: string
): string {
  const identity = createWorktreeIdentity({
    worktreeId: WORKTREE_ID,
    executionHostId: host,
    instanceId
  })
  const { preparationId } = records.register(identity, WORKTREE_ID)
  const intake = { preparationId, role: 'preparation' as const }
  records.reserve(intake, WORKTREE_ID, { handle: `term-${instanceId}`, tabId: null, leafId: null })
  records.bind(intake, WORKTREE_ID, {
    handle: `term-${instanceId}`,
    ptyId: `pty-${host}-${instanceId}`,
    incarnationId: 'inc-1',
    tabId: null,
    leafId: null,
    paneKey: null
  })
  output.observe(`pty-${host}-${instanceId}`, { startSequence: 0, endSequence: 5, data: 'done\n' })
  const committed = output.commit({ preparationId, inputRevision: 0 })
  if (!committed.committed) {
    throw new Error(`commit refused: ${committed.reason}`)
  }
  return committed.archiveId
}

function removalStore(meta: { hostId: string; instanceId: string }): Store {
  const directory = mkdtempSync(join(tmpdir(), 'orca-removal-profile-'))
  directories.push(directory)
  let current: typeof meta | undefined = meta
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: removal reads only these Store members.
  return {
    getWorktreeMeta: () => current,
    getWorktreeMetaForHost: (_worktreeId: string, host: string) =>
      current?.hostId === host ? current : undefined,
    removeWorktreeMeta: () => {
      current = undefined
    },
    getProfileStorageDirectory: () => directory
  } as unknown as Store
}

function preparationRuntime(): {
  output: PreparationOutputRuntime
  records: PreparationRecordStore
} {
  const directory = mkdtempSync(join(tmpdir(), 'orca-removal-preparation-'))
  directories.push(directory)
  const records = new PreparationRecordStore()
  const output = new PreparationOutputRuntime({ records })
  output.configureStorage({ directory })
  runtimes.push(output)
  return { output, records }
}

it('purges only the removed host/generation archives after successful deletion', () => {
  const { output, records } = preparationRuntime()
  const removed = archivedGeneration(output, records, 'local', 'instance-old')
  const sameIdReplacement = archivedGeneration(output, records, 'local', 'instance-new')
  const remote = archivedGeneration(output, records, 'ssh:build-box', 'instance-old')

  removeWorktreeMetadataAndTransientState(
    removalStore({ hostId: 'local', instanceId: 'instance-old' }),
    WORKTREE_ID,
    'local'
  )

  const store = output.outputStore()!
  expect(() => store.read({ archiveId: removed })).toThrow('preparation_output_archive_not_found')
  expect(store.read({ archiveId: sameIdReplacement }).text).toBe('done\n')
  expect(store.read({ archiveId: remote }).text).toBe('done\n')
  expect(output.lifecycle()!.deletionObligations()).toEqual([])
})

it('purges a remote generation through the same removal path', () => {
  const { output, records } = preparationRuntime()
  const removed = archivedGeneration(output, records, 'ssh:build-box', 'instance-old')
  const local = archivedGeneration(output, records, 'local', 'instance-old')

  removeWorktreeMetadataAndTransientState(
    removalStore({ hostId: 'ssh:build-box', instanceId: 'instance-old' }),
    WORKTREE_ID,
    'ssh:build-box'
  )

  const store = output.outputStore()!
  expect(() => store.read({ archiveId: removed })).toThrow('preparation_output_archive_not_found')
  expect(store.read({ archiveId: local }).text).toBe('done\n')
})

it('keeps archives when the worktree is forgotten rather than deleted', () => {
  const { output, records } = preparationRuntime()
  const kept = archivedGeneration(output, records, 'local', 'instance-old')

  removeWorktreeMetadataAndTransientState(
    removalStore({ hostId: 'local', instanceId: 'instance-old' }),
    WORKTREE_ID,
    'local',
    undefined,
    { purgePreparationArchives: false }
  )

  expect(output.outputStore()!.read({ archiveId: kept }).text).toBe('done\n')
})
