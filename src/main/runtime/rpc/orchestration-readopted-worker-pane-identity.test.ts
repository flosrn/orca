import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import type { RpcRequest, RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'

// Measured 2026-09-04 (flosrn/ax#160, dispatch ctx_66bcf1795f09): Orca was quit and
// relaunched while the daemon kept the worker PTY, so the agent kept running with
// its original ORCA_TERMINAL_HANDLE and its `<ptyId>:<incarnationId>` process
// incarnation. Nothing re-materialized its pane, so `pty.paneKey` came back null,
// the runtime resolved no pane key for the sender, and the agent's worker_done was
// refused "The caller is not the Dispatch pane."
const WORKER_HANDLE = 'term_readopted_worker'
const WORKER_PANE = 'tab_readopted:33333333-3333-4333-8333-333333333333'
const COORDINATOR_HANDLE = 'term_readopted_coordinator'
const COORDINATOR_PANE = 'tab_coord:44444444-4444-4444-8444-444444444444'
const WORKTREE_ID = 'repo::/retained-worktree'
const PTY_ID = 'repo::/retained-worktree@@hash'
const INCARNATION_ID = 'incarnation-stable'
const INTRUDER_HANDLE = 'term_intruder'
const INTRUDER_PANE = 'tab_intruder:99999999-9999-4999-8999-999999999999'
const INTRUDER_PTY_ID = 'repo::/retained-worktree@@intruder'

type RuntimeInternals = {
  ptysById: Map<string, unknown>
  handleByPtyId: Map<string, string>
  recordPtyWorktree: (ptyId: string, worktreeId: string, state: Record<string, unknown>) => void
  issuePtyHandle: (pty: unknown) => string
  restoreReadoptedWorkerPaneIdentity: (
    pty: unknown,
    identity: { handle: string; incarnationId: string }
  ) => boolean
}

type Harness = {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  internals: RuntimeInternals
  dispatcher: RpcDispatcher
  taskId: string
  dispatchId: string
  capability: string
}

const openDbs: OrchestrationDb[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close()
  }
  vi.restoreAllMocks()
})

/** A supervised worker whose PTY the daemon carried across a runtime restart. */
function createReadoptedWorker(): Harness {
  const db = new OrchestrationDb(':memory:')
  openDbs.push(db)
  const run = db.createRun({
    objective: 'survive a runtime restart',
    coordinatorHandle: COORDINATOR_HANDLE,
    coordinatorPaneKey: COORDINATOR_PANE
  })
  const task = db.createTask({ spec: 'finish after the restart', runId: run.id })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: { topology: 'current', agent: 'codex' }
  })
  const capability = db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: WORKER_HANDLE,
    paneKey: WORKER_PANE,
    processIncarnation: `${PTY_ID}:${INCARNATION_ID}`,
    worktreeId: WORKTREE_ID,
    setupState: 'not_applicable',
    effects: [{ kind: 'terminal', action: 'created', id: WORKER_HANDLE }]
  })
  db.markWorkerDispatchReady(started.dispatch.id)

  const runtime = new OrcaRuntimeService(null, undefined)
  // Reaching runtime internals is how the sibling restart tests seed PTY state.
  const internals = runtime as unknown as RuntimeInternals
  // The restart left connected PTYs with no renderer surface: no pane key, no tab,
  // and no restored-authority receipt — only the identity the daemon reported.
  for (const [ptyId, handle] of [
    [PTY_ID, WORKER_HANDLE],
    [INTRUDER_PTY_ID, INTRUDER_HANDLE]
  ]) {
    internals.recordPtyWorktree(ptyId, WORKTREE_ID, {
      connected: true,
      incarnationId: INCARNATION_ID
    })
    internals.handleByPtyId.set(ptyId, handle)
    internals.issuePtyHandle(internals.ptysById.get(ptyId))
  }
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

  return {
    db,
    runtime,
    internals,
    dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }),
    taskId: task.id,
    dispatchId: started.dispatch.id,
    capability
  }
}

function workerDone(harness: Harness, from: string, invocationId: string): RpcRequest {
  const request = {
    id: `rpc_${invocationId}`,
    authToken: 'caller-token',
    method: 'orchestration.send',
    params: {
      from,
      to: COORDINATOR_HANDLE,
      type: 'worker_done',
      subject: 'Completed',
      body: 'work survived the restart',
      payload: JSON.stringify({
        taskId: harness.taskId,
        dispatchId: harness.dispatchId,
        outcome: 'succeeded'
      })
    },
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: invocationId,
    orchestrationCapability: harness.capability
  }
  // Unchecked cast: the RPC envelope carries orchestration fields the base type omits.
  return request as unknown as RpcRequest
}

function lifecycleOf(response: RpcResponse): unknown {
  expect(response.ok, JSON.stringify(response)).toBe(true)
  if (!response.ok || !response.result || typeof response.result !== 'object') {
    return undefined
  }
  return 'lifecycle' in response.result ? response.result.lifecycle : undefined
}

function restorePaneIdentity(
  harness: Harness,
  identity: { handle: string; incarnationId: string } = {
    handle: WORKER_HANDLE,
    incarnationId: INCARNATION_ID
  }
): boolean {
  return harness.internals.restoreReadoptedWorkerPaneIdentity(
    harness.internals.ptysById.get(PTY_ID),
    identity
  )
}

describe('re-adopted worker pane identity', () => {
  it('refuses the surviving worker report while the re-adopted PTY has no pane identity', async () => {
    const harness = createReadoptedWorker()

    expect(harness.runtime.getTerminalPaneKey(WORKER_HANDLE)).toBeNull()
    const response = await harness.dispatcher.dispatch(
      workerDone(harness, WORKER_HANDLE, 'paneless-worker-done')
    )

    expect(lifecycleOf(response)).toMatchObject({
      action: 'rejected',
      code: 'dispatch_capability_invalid',
      reason: 'The caller is not the Dispatch pane.'
    })
    expect(harness.db.getTask(harness.taskId)).toMatchObject({ status: 'dispatched' })
  })

  it('settles worker_done once the Dispatch row restores the re-adopted pane identity', async () => {
    const harness = createReadoptedWorker()

    expect(restorePaneIdentity(harness)).toBe(true)
    expect(harness.runtime.getTerminalPaneKey(WORKER_HANDLE)).toBe(WORKER_PANE)

    const response = await harness.dispatcher.dispatch(
      workerDone(harness, WORKER_HANDLE, 'readopted-worker-done')
    )

    expect(lifecycleOf(response)).toMatchObject({ action: 'completed' })
    expect(harness.db.getTask(harness.taskId)).toMatchObject({ status: 'completed' })
    expect(harness.db.getDispatchContextById(harness.dispatchId)).toMatchObject({
      status: 'completed',
      assignee_handle: WORKER_HANDLE,
      assignee_pane_key: WORKER_PANE,
      process_incarnation: `${PTY_ID}:${INCARNATION_ID}`
    })
  })

  it('still refuses a worker_done from a terminal that is not the assignee', async () => {
    const harness = createReadoptedWorker()
    expect(restorePaneIdentity(harness)).toBe(true)
    harness.internals.restoreReadoptedWorkerPaneIdentity(
      harness.internals.ptysById.get(INTRUDER_PTY_ID),
      { handle: INTRUDER_HANDLE, incarnationId: INCARNATION_ID }
    )
    const intruderPty = harness.internals.ptysById.get(INTRUDER_PTY_ID)
    if (intruderPty && typeof intruderPty === 'object' && 'paneKey' in intruderPty) {
      // The intruder pane exists in its own right; only its Dispatch claim is bogus.
      intruderPty.paneKey = INTRUDER_PANE
    }

    const response = await harness.dispatcher.dispatch(
      workerDone(harness, INTRUDER_HANDLE, 'intruder-worker-done')
    )

    expect(lifecycleOf(response)).toMatchObject({
      action: 'rejected',
      code: 'dispatch_capability_invalid',
      reason: 'The caller is not the Dispatch pane.'
    })
    expect(harness.db.getTask(harness.taskId)).toMatchObject({ status: 'dispatched' })
    expect(harness.db.getDispatchContextById(harness.dispatchId)).toMatchObject({
      status: 'dispatched',
      assignee_pane_key: WORKER_PANE
    })
  })

  it('restores no pane identity for an identity the Dispatch does not name', () => {
    const harness = createReadoptedWorker()

    expect(restorePaneIdentity(harness, { handle: INTRUDER_HANDLE, incarnationId: INCARNATION_ID }))
      .toBe(false)
    // Why: a replaced PTY is a different process, so the Dispatch's pane is not its
    // pane to inherit.
    expect(
      restorePaneIdentity(harness, {
        handle: WORKER_HANDLE,
        incarnationId: 'incarnation-respawned'
      })
    ).toBe(false)
    expect(harness.runtime.getTerminalPaneKey(WORKER_HANDLE)).toBeNull()
  })
})
