import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import type { OrcaRuntimeService } from './orca-runtime'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  createRuntimeWithSshLease
} from './orca-runtime-test-fixtures.spec'
import { makePaneKey } from './orca-runtime-test-mocks.spec'

const COORDINATOR_HANDLE = 'term_coord'
const COORDINATOR_PANE = 'tab_coord:44444444-4444-4444-8444-444444444444'
const WORKER_PANE_TAB = 'tab-obsolete-restore'
const WORKER_PTY = 'ssh:ssh-target@@pty-obsolete'

const openDbs: OrchestrationDb[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close()
  }
  vi.restoreAllMocks()
})

function seedTask(db: OrchestrationDb, spec: string) {
  const run = db.createRun({
    objective: spec,
    coordinatorHandle: COORDINATOR_HANDLE,
    coordinatorPaneKey: COORDINATOR_PANE
  })
  return db.createTask({ spec, runId: run.id })
}

function startWorker(db: OrchestrationDb, taskId: string, handle: string, paneKey: string) {
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId,
    startOptions: { topology: 'current', agent: 'codex' }
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle,
    paneKey,
    processIncarnation: `${WORKER_PTY}:incarnation-old`,
    worktreeId: TEST_WORKTREE_ID,
    setupState: 'not_applicable',
    effects: [{ kind: 'terminal', action: 'created', id: handle }]
  })
  return started.dispatch.id
}

function bindWorker(db: OrchestrationDb, taskId: string, handle: string, paneKey: string) {
  const dispatchId = startWorker(db, taskId, handle, paneKey)
  db.markWorkerDispatchReady(dispatchId)
  return dispatchId
}
function recoverablePane() {
  const runtime = createRuntimeWithSshLease(WORKER_PTY, WORKER_PANE_TAB)
  const paneKey = makePaneKey(WORKER_PANE_TAB, HEADLESS_LEAF_ID)
  runtime.registerPty(WORKER_PTY, TEST_WORKTREE_ID, 'ssh-target', {
    tabId: WORKER_PANE_TAB,
    leafId: HEADLESS_LEAF_ID
  })
  const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
  runtime.onPtyExit(WORKER_PTY, -1, undefined, { hostExitConfirmed: true })
  const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: 'term-replacement',
    tabId: WORKER_PANE_TAB,
    paneKey,
    ptyId: 'pty-replacement',
    worktreeId: TEST_WORKTREE_ID,
    title: null,
    surface: 'background'
  })
  return { runtime, paneKey, handle, createTerminal }
}

type RecoveryInventoryReader = {
  hasRecentExpiredSshLeasePane(
    worktreeId: string,
    tab: { parentTabId: string; leafId: string }
  ): boolean
}

function inventoryAdvertises(runtime: OrcaRuntimeService, tabId: string): boolean {
  // Protected member driven directly by this test; shape is its real declaration in
  // orca-runtime-reconcile-headless-mobile-session-browser-tabs.ts.
  const reader = runtime as unknown as RecoveryInventoryReader
  return reader.hasRecentExpiredSshLeasePane(TEST_WORKTREE_ID, {
    parentTabId: tabId,
    leafId: HEADLESS_LEAF_ID
  })
}

describe('recoverTerminalPane obsolete dispatch restore', () => {
  it('does not spawn when the pane handle is proven superseded by a newer same-task dispatch', async () => {
    const { runtime, paneKey, handle, createTerminal } = recoverablePane()
    const db = new OrchestrationDb(':memory:')
    openDbs.push(db)
    const task = seedTask(db, 'replaced worker')
    const priorId = startWorker(db, task.id, handle, paneKey)
    db.failWorkerStart(priorId, 'agent_readiness', 'replaced')
    db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      retryOf: priorId,
      startOptions: { topology: 'current', agent: 'codex' }
    })
    runtime.setOrchestrationDb(db)

    expect(inventoryAdvertises(runtime, WORKER_PANE_TAB)).toBe(false)
    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('still spawns when the handle is the task latest — completed is not superseded', async () => {
    const { runtime, paneKey, handle, createTerminal } = recoverablePane()
    const db = new OrchestrationDb(':memory:')
    openDbs.push(db)
    const task = seedTask(db, 'finished worker')
    bindWorker(db, task.id, handle, paneKey)
    db.settleWorkerReport({
      taskId: task.id,
      dispatchId: db.getDispatchContext(task.id)!.id,
      outcome: 'succeeded',
      result: '{}'
    })
    runtime.setOrchestrationDb(db)

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    ).resolves.toMatchObject({ handle: 'term-replacement' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('still spawns when there is no dispatch row', async () => {
    const { runtime, paneKey, handle, createTerminal } = recoverablePane()
    const db = new OrchestrationDb(':memory:')
    openDbs.push(db)
    runtime.setOrchestrationDb(db)

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    ).resolves.toMatchObject({ handle: 'term-replacement' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('still spawns when a newer dispatch belongs to a different task', async () => {
    const { runtime, paneKey, handle, createTerminal } = recoverablePane()
    const db = new OrchestrationDb(':memory:')
    openDbs.push(db)
    const original = seedTask(db, 'original')
    bindWorker(db, original.id, handle, paneKey)
    const other = seedTask(db, 'other worker')
    bindWorker(db, other.id, 'term_other', 'tab_other:66666666-6666-4666-8666-666666666666')
    runtime.setOrchestrationDb(db)

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    ).resolves.toMatchObject({ handle: 'term-replacement' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('does not spawn when the dispatch lookup throws', async () => {
    const { runtime, paneKey, handle, createTerminal } = recoverablePane()
    const db = new OrchestrationDb(':memory:')
    openDbs.push(db)
    vi.spyOn(db, 'getLatestDispatchForTerminal').mockImplementation(() => {
      throw new Error('db_unreadable')
    })
    runtime.setOrchestrationDb(db)

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })
})
