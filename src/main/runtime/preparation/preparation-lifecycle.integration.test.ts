import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { retainPty, type PtyIdleRetirementResult } from '../../../shared/pty-idle-retirement'
import { SETUP_COMPLETION_PREFIX } from '../../../shared/setup-completion-marker'
import { PREPARATION_OUTPUT_CAPTURE_LIMIT_BYTES } from './preparation-output-contracts'
import type { Prepared } from './preparation-lifecycle-test-harness.spec'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

// Dynamic on purpose: vi.mock fragments must register before the runtime fixtures load.
const {
  RETIREMENT_TIMEOUT_MS,
  RUNNER,
  archives,
  awaitRetirement,
  completeRunner,
  createLocalPreparation,
  createSshPreparation,
  expectOnlySetupStopped,
  expectRetained,
  installRuntime,
  openSiblings,
  persistSession,
  readinessReceipt,
  resetPreparationLifecycleHarness,
  setupOutput
} = await import('./preparation-lifecycle-test-harness.spec')
const { preparationFacts, resetPreparationObservationsForTests } =
  await import('./preparation-observation')

/**
 * AE1–AE9 through the managing runtime's real seams: creation registers the preparation, the
 * runtime observes the full runner and the root takeover, archives the output, asks the provider
 * seam for an exact idle stop, and removes exactly the leaf. Only the execution host (spawn,
 * input counter, exact stop) and the hook transport are stood in for.
 */

beforeEach(resetPreparationLifecycleHarness)
afterEach(resetPreparationLifecycleHarness)

describe('preparation lifecycle', () => {
  it.each([
    ['worker', 'start-immediately', 'runner'],
    ['worker', 'wait-for-setup', 'takeover'],
    ['manual', 'start-immediately', 'takeover'],
    ['manual', 'wait-for-setup', 'runner']
  ] as const)(
    'AE1/AE7: %s creation (%s) retires Setup only after the full runner and root takeover, %s first',
    async (surface, policy, first) => {
      const p = await createLocalPreparation({
        label: `prep-life-${surface}-${policy}-${first}`,
        surface,
        policy
      })
      persistSession(p, 'tabs')
      setupOutput(p, 'installing dependencies\n')
      if (first === 'runner') {
        completeRunner(p)
        expect(preparationFacts(p.preparationId).outcome?.status).toBe('succeeded')
        readinessReceipt(p)
      } else {
        readinessReceipt(p)
        expect(preparationFacts(p.preparationId).takeover?.ready).toBe(true)
        await expect(p.runtime.evaluatePreparationRetirement(p.preparationId)).resolves.toEqual({
          outcome: 'retained',
          blockers: ['handoff-unproven']
        })
        completeRunner(p)
      }

      await awaitRetirement(p)
      expectOnlySetupStopped(p)
      const session = p.persisted.getSession()
      // Setup was its tab's only leaf, so the tab goes; the agent's tab is untouched.
      expect(session.tabsByWorktree[p.worktreeId]?.map((tab) => tab.id)).toEqual([p.agent.tabId])
      expect(session.terminalLayoutsByTabId[p.setup.tabId]).toBeUndefined()
      expect(session.terminalLayoutsByTabId[p.agent.tabId]?.ptyIdsByLeafId).toEqual({
        [p.agent.leafId]: p.agent.ptyId
      })
      const { terminals } = await p.runtime.listTerminals()
      expect(terminals).toEqual(
        expect.arrayContaining([expect.objectContaining({ ptyId: p.agent.ptyId })])
      )
      // R3: the output stays readable from the archive, without the PTY.
      const [archive, ...others] = archives(p.runtime, p)
      expect(others).toEqual([])
      expect(archive?.text).toContain('installing dependencies')
      expect(p.runtime.mayEnqueuePreparationSetup(p.preparationId)).toBe(false)
    },
    15_000
  )

  it.each(['start-immediately', 'wait-for-setup'] as const)(
    'AE7: an SSH-executed worker preparation (%s) retires through the provider stop and archives under its host',
    async (policy) => {
      const p = await createSshPreparation(`prep-life-ssh-${policy}`, policy)
      expect(p.record.worktree.executionHostId).not.toBe('local')
      persistSession(p, 'tabs')
      setupOutput(p, 'remote install\n')
      readinessReceipt(p)
      completeRunner(p)

      await awaitRetirement(p)
      expectOnlySetupStopped(p)
      const [archive] = archives(p.runtime, p)
      expect(archive).toMatchObject({ host: p.record.worktree.executionHostId })
      expect(archive?.text).toContain('remote install')
    },
    15_000
  )

  it('AE2: finishing earlier steps, or another runner`s marker, never triggers cleanup', async () => {
    const p = await createLocalPreparation({
      label: 'prep-life-multi-step',
      surface: 'worker',
      policy: 'start-immediately'
    })
    persistSession(p, 'tabs')
    readinessReceipt(p)
    for (const step of [
      'step 1/3: install\n',
      'step 2/3: codegen\n',
      `${SETUP_COMPLETION_PREFIX}nested-runner:0\r\n`
    ]) {
      setupOutput(p, step)
      await expect(p.runtime.evaluatePreparationRetirement(p.preparationId)).resolves.toEqual({
        outcome: 'retained',
        blockers: ['handoff-unproven']
      })
    }
    expect(p.retireIdle).not.toHaveBeenCalled()

    setupOutput(p, 'step 3/3: migrate\n')
    completeRunner(p)
    await awaitRetirement(p)
    const [archive] = archives(p.runtime, p)
    expect(archive?.text).toContain('step 1/3: install')
    expect(archive?.text).toContain('step 3/3: migrate')
  })

  it.each([
    ['fails', 1],
    ['is cancelled', 130]
  ] as const)(
    'AE3: a runner that %s stays visible even after the agent takes over',
    async (_case, status) => {
      const p = await createLocalPreparation({
        label: `prep-life-runner-${status}`,
        surface: 'worker',
        policy: 'wait-for-setup'
      })
      const before = persistSession(p, 'tabs')
      setupOutput(p, 'error: install failed\n')
      completeRunner(p, status)
      readinessReceipt(p)

      expect(preparationFacts(p.preparationId).outcome?.status).toBe('failed')
      await expect(p.runtime.evaluatePreparationRetirement(p.preparationId)).resolves.toEqual({
        outcome: 'retained',
        blockers: ['handoff-unproven']
      })
      await expectRetained(p, before)
    }
  )

  it('AE4: a successful runner without an authenticated root takeover stays visible', async () => {
    const p = await createLocalPreparation({
      label: 'prep-life-no-agent',
      surface: 'manual',
      policy: 'start-immediately'
    })
    const before = persistSession(p, 'tabs')
    setupOutput(p, 'ready\n')
    completeRunner(p)
    // Process creation and an unauthenticated post are not a takeover.
    readinessReceipt(p, { authenticated: false })

    expect(preparationFacts(p.preparationId).takeover).toBeNull()
    await expect(p.runtime.evaluatePreparationRetirement(p.preparationId)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['handoff-unproven']
    })
    await expectRetained(p, before)
  })

  it('AE4: a readiness receipt ingested after the agent incarnation exited never authorizes cleanup', async () => {
    const p = await createLocalPreparation({
      label: 'prep-life-stale-agent',
      surface: 'worker',
      policy: 'start-immediately'
    })
    persistSession(p, 'tabs')
    setupOutput(p, 'ready\n')
    completeRunner(p)
    // OMP failed to start: its pane exited before a (delayed or replayed) receipt was ingested.
    p.runtime.onPtyExit(p.agent.ptyId, 1, p.agent.incarnationId)
    readinessReceipt(p)

    expect(preparationFacts(p.preparationId).takeover).toBeNull()
    await expect(p.runtime.evaluatePreparationRetirement(p.preparationId)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['handoff-unproven']
    })
    expect(p.retireIdle).not.toHaveBeenCalled()
  })

  it('AE1: root readiness carried on a later status post counts when its session_start post was coalesced', async () => {
    const p = await createLocalPreparation({
      label: 'prep-life-carried-receipt',
      surface: 'worker',
      policy: 'start-immediately'
    })
    persistSession(p, 'tabs')
    setupOutput(p, 'ready\n')
    completeRunner(p)
    // The extension keeps the readiness fields on every later post of the runner, because its
    // latest-only queue can replace an undelivered session_start with the next status.
    readinessReceipt(p, { hookEventName: 'agent_start' })

    expect(preparationFacts(p.preparationId).takeover?.ready).toBe(true)
    await awaitRetirement(p)
    expectOnlySetupStopped(p)
  })

  it('AE5/AE6: removes only the Setup leaf beside OMP and leaves a server, a watcher and a manual shell running', async () => {
    const p = await createLocalPreparation({
      label: 'prep-life-mixed',
      surface: 'worker',
      policy: 'start-immediately'
    })
    const siblings = await openSiblings(p)
    const before = persistSession(p, 'split', [siblings.server, siblings.watcher, siblings.shell])
    setupOutput(p, 'installing\n')
    completeRunner(p)
    readinessReceipt(p)

    await awaitRetirement(p)
    expectOnlySetupStopped(p)
    const session = p.persisted.getSession()
    expect(session.tabsByWorktree[p.worktreeId]?.map((tab) => tab.id)).toEqual(
      before.tabsByWorktree[p.worktreeId]?.map((tab) => tab.id)
    )
    expect(session.terminalLayoutsByTabId[p.setup.tabId]?.ptyIdsByLeafId).toEqual({
      [p.agent.leafId]: p.agent.ptyId
    })
    for (const ptyId of Object.values(siblings)) {
      expect(session.terminalLayoutsByTabId[`tab-${ptyId}`]).toEqual(
        before.terminalLayoutsByTabId[`tab-${ptyId}`]
      )
    }
  })

  it('AE6/AX: work still running inside Setup keeps it, and the refused cleanup stays occupancy', async () => {
    const p = await createLocalPreparation({
      label: 'prep-life-not-idle',
      surface: 'worker',
      policy: 'start-immediately'
    })
    const before = persistSession(p, 'tabs')
    p.provider.answer = async () => retainPty('not_idle')
    setupOutput(p, 'watching for changes\n')
    completeRunner(p)
    readinessReceipt(p)

    await vi.waitFor(() => expect(p.retireIdle).toHaveBeenCalledTimes(1), {
      timeout: RETIREMENT_TIMEOUT_MS
    })
    await expect(p.runtime.evaluatePreparationRetirement(p.preparationId)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['provider:not_idle']
    })
    expect(p.kill).not.toHaveBeenCalled()
    expect(p.retireTerminalSurface).not.toHaveBeenCalled()
    expect(p.persisted.getSession()).toEqual(before)
    const { terminals } = await p.runtime.listTerminals()
    expect(terminals).toEqual(
      expect.arrayContaining([expect.objectContaining({ ptyId: p.setup.ptyId })])
    )
    // The archive committed for the attempt stays readable although the pane stays.
    expect(archives(p.runtime, p)[0]?.text).toContain('watching for changes')
  })

  it('AE6: operator input while output settles retains Setup without asking for a stop', async () => {
    const p = await createLocalPreparation({
      label: 'prep-life-input',
      surface: 'manual',
      policy: 'wait-for-setup'
    })
    const before = persistSession(p, 'tabs')
    setupOutput(p, 'done\n')
    completeRunner(p)
    readinessReceipt(p)
    // The evaluation fences the input revision synchronously, then waits 250 ms for output to
    // settle; input the operator types during that wait refutes the fence.
    const verdict = p.runtime.evaluatePreparationRetirement(p.preparationId)
    p.inputs.set(p.setup.ptyId, 1)

    await expect(verdict).resolves.toEqual({ outcome: 'retained', blockers: ['input-changed'] })
    await expectRetained(p, before)
  })

  it('AE8: an archive that cannot be written keeps Setup and its live output', async () => {
    const p = await createLocalPreparation({
      label: 'prep-life-archive-failure',
      surface: 'worker',
      policy: 'start-immediately'
    })
    const before = persistSession(p, 'tabs')
    // The archive root is occupied by a file, so the private temp write cannot happen.
    const archiveRoot = join(p.directory, 'archives')
    rmSync(archiveRoot, { recursive: true, force: true })
    writeFileSync(archiveRoot, 'not a directory')
    setupOutput(p, 'installing\n')
    completeRunner(p)
    readinessReceipt(p)

    await expect(p.runtime.evaluatePreparationRetirement(p.preparationId)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['archive-uncommitted']
    })
    await expectRetained(p, before)
  })

  it('AE8: output past the 16 MiB capture limit is not preserved, so Setup is kept', async () => {
    const p = await createLocalPreparation({
      label: 'prep-life-overflow',
      surface: 'worker',
      policy: 'start-immediately'
    })
    const before = persistSession(p, 'tabs')
    setupOutput(p, `${'x'.repeat(PREPARATION_OUTPUT_CAPTURE_LIMIT_BYTES)}\n`)
    completeRunner(p)
    readinessReceipt(p)

    await expect(p.runtime.evaluatePreparationRetirement(p.preparationId)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['archive-uncommitted']
    })
    await expectRetained(p, before)
    expect(archives(p.runtime, p)).toEqual([])
  }, 30_000)

  it('AE9: a Setup-titled shell running the same command, even printing this creation`s marker, is never adopted', async () => {
    const p = await createLocalPreparation({
      label: 'prep-life-lookalike',
      surface: 'worker',
      policy: 'start-immediately'
    })
    await p.runtime.createTerminal(`id:${p.worktreeId}`, {
      title: 'Setup',
      command: `bash ${RUNNER}`
    })
    const lookalike = p.spawned.extras.at(-1)!
    const before = persistSession(p, 'tabs', [lookalike])
    p.runtime.onPtyData(lookalike, `${SETUP_COMPLETION_PREFIX}${p.token}:0\r\n$ `, Date.now())
    readinessReceipt(p)

    expect(preparationFacts(p.preparationId).outcome).toBeNull()
    await expect(p.runtime.evaluatePreparationRetirement(p.preparationId)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['handoff-unproven']
    })
    expect(p.runtime.listPreparationRecords()).toEqual([
      expect.objectContaining({ preparation: expect.objectContaining({ ptyId: p.setup.ptyId }) })
    ])
    await expectRetained(p, before)
  })

  describe('restart', () => {
    function restart(p: Prepared, label: string) {
      // Observation facts live in process memory; a restart loses them with the process.
      resetPreparationObservationsForTests()
      return installRuntime(label, p.persisted.runtimeStore, p.directory)
    }

    it.each(['spawn binding', 'runner outcome'] as const)(
      'after %s, recovery keeps the live pane without closure authority or a rerun',
      async (point) => {
        const label = `prep-life-restart-${point.replace(' ', '-')}`
        const p = await createLocalPreparation({
          label,
          surface: 'worker',
          policy: 'start-immediately'
        })
        const before = persistSession(p, 'tabs')
        setupOutput(p, 'installing\n')
        if (point === 'runner outcome') {
          completeRunner(p)
        }

        const restarted = restart(p, `${label}-restarted`)
        // Startup readback: the provider says the pty is alive, but no incarnation re-announced
        // yet, so recovery cannot tell which process it is and changes nothing.
        restarted.provider.liveness = async () => true
        await expect(restarted.runtime.recoverPreparationLifecycle()).resolves.toEqual([
          { preparationId: p.preparationId, action: 'retain', reason: 'unverifiable' }
        ])
        // The exact recorded incarnation re-announces: the pane is kept, but the pre-crash capture
        // lived only in memory, so its beginning is gone and no closure is ever authorized.
        restarted.runtime.onPtySpawned(p.setup.ptyId, p.setup.incarnationId)
        await expect(restarted.runtime.recoverPreparationLifecycle()).resolves.toEqual([])
        expect(restarted.runtime.mayEnqueuePreparationSetup(p.preparationId)).toBe(true)
        await expect(
          restarted.runtime.evaluatePreparationRetirement(p.preparationId)
        ).resolves.toEqual({ outcome: 'retained', blockers: ['unregistered'] })
        expect(restarted.retireIdle).not.toHaveBeenCalled()
        expect(restarted.spawn).not.toHaveBeenCalled()
        expect(p.retireIdle).not.toHaveBeenCalled()
        expect(p.persisted.getSession()).toEqual(before)
      }
    )

    it.each([
      ['the old incarnation is still live', 'live-old', 'reattach'],
      ['a replacement owns the pane', 'live-replacement', 'retired'],
      ['the old incarnation exited', 'exited', 'retired']
    ] as const)(
      'with the exact stop outstanding after the archive commit, and %s, nothing else is stopped or rerun',
      async (_case, observed, action) => {
        const label = `prep-life-restart-stop-${observed}`
        const p = await createLocalPreparation({
          label,
          surface: 'worker',
          policy: 'start-immediately'
        })
        persistSession(p, 'tabs')
        // The process dies while the host holds the stop request: no answer ever arrives.
        p.provider.answer = () => Promise.withResolvers<PtyIdleRetirementResult>().promise
        setupOutput(p, 'installing\n')
        completeRunner(p)
        readinessReceipt(p)
        await vi.waitFor(() => expect(p.retireIdle).toHaveBeenCalledTimes(1), {
          timeout: RETIREMENT_TIMEOUT_MS
        })

        const restarted = restart(p, `${label}-restarted`)
        if (observed === 'exited') {
          // Nothing re-announces a dead pane: only the startup readback can settle its close.
          restarted.provider.liveness = async () => false
          await expect(restarted.runtime.recoverPreparationLifecycle()).resolves.toEqual([
            { preparationId: p.preparationId, action }
          ])
        } else {
          restarted.runtime.onPtySpawned(
            p.setup.ptyId,
            observed === 'live-old' ? p.setup.incarnationId : 'inc-replacement'
          )
          // The re-announcement settled the pane; startup readback leaves it alone.
          restarted.provider.liveness = async () => true
          await expect(restarted.runtime.recoverPreparationLifecycle()).resolves.toEqual([])
        }
        // The archive committed before the stop survives the crash and stays readable.
        expect(archives(restarted.runtime, p)[0]?.text).toContain('installing')
        await expect(
          restarted.runtime.evaluatePreparationRetirement(p.preparationId)
        ).resolves.toEqual({ outcome: 'retained', blockers: ['unregistered'] })
        expect(restarted.retireIdle).not.toHaveBeenCalled()
        expect(restarted.runtime.mayEnqueuePreparationSetup(p.preparationId)).toBe(
          action !== 'retired'
        )
        if (action === 'retired') {
          await expect(
            restarted.runtime.createTerminal(`id:${p.worktreeId}`, {
              preparation: { preparationId: p.preparationId, role: 'preparation' }
            })
          ).rejects.toThrow('preparation_retired')
        }
        expect(restarted.spawn).not.toHaveBeenCalled()
      }
    )
  })
})
