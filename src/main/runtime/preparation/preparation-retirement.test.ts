// Compare-and-retire: automatic cleanup removes exactly one proven-idle preparation
// leaf, archive-backed and identity-fenced, and retains it on any missing or changed proof.
// Lifecycle facts live in the real PreparationLifecycleStore on disk; the persisted layout is
// mutated by the canonical leaf-retirement helper. Time is a deterministic clock.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { PreparationRecord } from '../../../shared/preparation-contracts'
import type { WorktreeIdentity } from '../../../shared/worktree/identity'
import {
  retainPty,
  type PtyIdleRetirementRequest,
  type PtyIdleRetirementResult
} from '../../../shared/pty-idle-retirement'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from '../mobile-session-terminal-persistence-retirement'
import type { PreparationArchiveCommit } from './preparation-output-contracts'
import { PreparationLifecycleStore } from './preparation-lifecycle-store'
import {
  PREPARATION_MAX_RESNAPSHOTS,
  PREPARATION_OUTPUT_QUIESCENCE_MS,
  PREPARATION_PROVIDER_STOP_BUDGET_MS,
  PREPARATION_SETTLEMENT_WINDOW_MS,
  createPreparationRetirement,
  type PreparationLeafFacts,
  type PreparationRetiredLeaf
} from './preparation-retirement'
import { PS_TIMEOUT_MS } from '../../../shared/process-table-snapshot-reader'

const PREPARATION_ID = 'prep-1'
const WORKTREE_ID = 'repo::/worktrees/feature'
const WORKTREE: WorktreeIdentity = {
  key: 'wt2:local:instance-1',
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  instanceId: 'instance-1'
}
const TAB = 'tab-shared'
const SETUP = { ptyId: 'pty-setup', incarnationId: 'inc-setup', leafId: 'leaf-setup' }
const AGENT = { ptyId: 'pty-omp', incarnationId: 'inc-omp', leafId: 'leaf-omp' }
const SERVICE = { tabId: 'tab-dev', leafId: 'leaf-dev', ptyId: 'pty-dev' }

function terminalTab(id: string, ptyId: string, title: string, sortOrder: number) {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

/** AE5/AE6: Setup and OMP split one tab; a dev server runs in its own tab. */
function initialSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        terminalTab(TAB, SETUP.ptyId, 'Setup', 0),
        terminalTab(SERVICE.tabId, SERVICE.ptyId, 'dev', 1)
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: SETUP.leafId },
          second: { type: 'leaf', leafId: AGENT.leafId }
        },
        activeLeafId: AGENT.leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SETUP.leafId]: SETUP.ptyId, [AGENT.leafId]: AGENT.ptyId }
      },
      [SERVICE.tabId]: {
        root: { type: 'leaf', leafId: SERVICE.leafId },
        activeLeafId: SERVICE.leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SERVICE.leafId]: SERVICE.ptyId }
      }
    },
    terminalPtyIncarnationsByPaneKey: {
      [`${TAB}:${SETUP.leafId}`]: SETUP.incarnationId,
      [`${TAB}:${AGENT.leafId}`]: AGENT.incarnationId
    }
  }
}

/**
 * The managing runtime as retirement sees it: live leaf facts, a synchronous archive commit that
 * records into the lifecycle store, output that invalidates the closure snapshot, and the
 * canonical persisted layout. Timed events fire as the retirement's clock advances.
 */
class FakeRuntime {
  now = 1_000
  session = initialSession()
  leaves = new Map<string, PreparationLeafFacts>()
  authorized = true
  record: PreparationRecord | null
  commits: Extract<PreparationArchiveCommit, { committed: true }>[] = []
  commitRefusal: PreparationArchiveCommit | null = null
  onCommit: (() => void) | null = null
  providerAnswers: (() => PtyIdleRetirementResult)[] = []
  retireIdle = vi.fn(
    async (ptyId: string, request: PtyIdleRetirementRequest): Promise<PtyIdleRetirementResult> => {
      const answer = this.providerAnswers.shift()
      if (answer) {
        return answer()
      }
      const live = this.leaves.get(ptyId)
      return live?.incarnationId === request.expectedIncarnationId
        ? { outcome: 'stopped' }
        : retainPty('incarnation_mismatch')
    }
  )
  removeLeaf = vi.fn(async (leaf: PreparationRetiredLeaf): Promise<boolean> => {
    this.session = retireTerminalSurfaceFromPersistence(this.session, {
      worktreeId: WORKTREE_ID,
      parentTabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      incarnationId: leaf.incarnationId
    })
    return true
  })
  private events: { at: number; run: () => void }[] = []

  constructor(readonly lifecycle: PreparationLifecycleStore) {
    this.record = {
      preparationId: PREPARATION_ID,
      worktree: WORKTREE,
      registeredAt: 1,
      preparation: {
        handle: 'term-setup',
        ptyId: SETUP.ptyId,
        incarnationId: SETUP.incarnationId,
        tabId: TAB,
        leafId: SETUP.leafId,
        paneKey: `${TAB}:${SETUP.leafId}`
      },
      agent: {
        handle: 'term-omp',
        ptyId: AGENT.ptyId,
        incarnationId: AGENT.incarnationId,
        tabId: TAB,
        leafId: AGENT.leafId,
        paneKey: `${TAB}:${AGENT.leafId}`
      }
    }
    lifecycle.track({
      preparationId: PREPARATION_ID,
      host: WORKTREE.executionHostId,
      worktreeKey: WORKTREE.key,
      instanceId: WORKTREE.instanceId
    })
    lifecycle.bindPane(PREPARATION_ID, 'preparation', SETUP)
    lifecycle.bindPane(PREPARATION_ID, 'agent', AGENT)
    this.leaves.set(SETUP.ptyId, {
      incarnationId: SETUP.incarnationId,
      tabId: TAB,
      leafId: SETUP.leafId,
      inputRevision: 0,
      layoutRevision: 0,
      outputSequence: 120,
      // The runner marker and prompt landed well before cleanup was evaluated.
      lastOutputAt: this.now - 10_000
    })
  }

  setup(): PreparationLeafFacts {
    const facts = this.leaves.get(SETUP.ptyId)
    if (!facts) {
      throw new Error('setup leaf missing')
    }
    return facts
  }

  output(chars = 8): void {
    const facts = this.setup()
    facts.outputSequence += chars
    facts.lastOutputAt = this.now
    this.lifecycle.recordOutput(PREPARATION_ID, facts.outputSequence)
  }

  input(): void {
    this.setup().inputRevision += 1
  }

  replace(): void {
    this.setup().incarnationId = 'inc-setup-replacement'
  }

  at(offsetMs: number, run: () => void): void {
    this.events.push({ at: this.now + offsetMs, run })
    this.events.sort((a, b) => a.at - b.at)
  }

  retirement() {
    return createPreparationRetirement({
      now: () => this.now,
      sleep: async (ms) => {
        const until = this.now + ms
        while (this.events[0] && this.events[0].at <= until) {
          const event = this.events.shift()!
          this.now = event.at
          event.run()
        }
        this.now = until
      },
      record: (preparationId) =>
        preparationId === this.record?.preparationId ? this.record : null,
      cleanupAuthorized: () => this.authorized,
      lifecycle: () => this.lifecycle,
      commitOutput: ({ preparationId, inputRevision }) => {
        if (this.commitRefusal) {
          return this.commitRefusal
        }
        const finalSequence = this.setup().outputSequence
        const commit: Extract<PreparationArchiveCommit, { committed: true }> = {
          committed: true,
          archiveId: `archive-${this.commits.length + 1}`,
          finalSequence,
          byteLength: finalSequence,
          committedAt: this.now,
          durability: 'established',
          redactionApplied: false
        }
        this.commits.push(commit)
        this.lifecycle.recordArchive(preparationId, {
          archiveId: commit.archiveId,
          finalSequence,
          inputRevision,
          durability: 'established'
        })
        this.onCommit?.()
        return commit
      },
      leafFacts: (ptyId) => {
        const facts = this.leaves.get(ptyId)
        return facts ? { ...facts } : null
      },
      retireIdle: this.retireIdle,
      removeLeaf: this.removeLeaf
    })
  }

  sessionLeafIds(tabId: string): string[] {
    return Object.keys(this.session.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {})
  }
}

describe('preparation retirement', () => {
  let directory: string
  let lifecycle: PreparationLifecycleStore
  let runtime: FakeRuntime

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-preparation-retirement-'))
    lifecycle = new PreparationLifecycleStore({ filePath: join(directory, 'lifecycle.json') })
    runtime = new FakeRuntime(lifecycle)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it('AE5: removes only the Setup leaf of a shared tab and tombstones the preparation', async () => {
    const before = initialSession()

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retired'
    })

    expect(runtime.retireIdle).toHaveBeenCalledTimes(1)
    expect(runtime.retireIdle).toHaveBeenCalledWith(
      SETUP.ptyId,
      expect.objectContaining({
        expectedIncarnationId: SETUP.incarnationId,
        expectedOutputChars: 120
      })
    )
    expect(runtime.retireIdle).not.toHaveBeenCalledWith(AGENT.ptyId, expect.anything())
    expect(runtime.sessionLeafIds(TAB)).toEqual([AGENT.leafId])
    expect(runtime.session.tabsByWorktree[WORKTREE_ID].map((tab) => tab.id)).toEqual([
      TAB,
      SERVICE.tabId
    ])
    expect(runtime.session.terminalLayoutsByTabId[SERVICE.tabId]).toEqual(
      before.terminalLayoutsByTabId[SERVICE.tabId]
    )
    // Restart reads the durable tombstone: the setup command may never run again.
    const restarted = new PreparationLifecycleStore({ filePath: join(directory, 'lifecycle.json') })
    expect(restarted.get(PREPARATION_ID)?.state).toBe('retired')
    expect(restarted.mayEnqueueSetup(PREPARATION_ID)).toBe(false)
  })

  it('removes the tab when the Setup leaf was its only leaf', async () => {
    runtime.session = retireTerminalSurfaceFromPersistence(runtime.session, {
      worktreeId: WORKTREE_ID,
      parentTabId: TAB,
      leafId: AGENT.leafId,
      ptyId: AGENT.ptyId,
      incarnationId: AGENT.incarnationId
    })

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retired'
    })
    expect(runtime.session.tabsByWorktree[WORKTREE_ID].map((tab) => tab.id)).toEqual([
      SERVICE.tabId
    ])
    expect(runtime.session.terminalLayoutsByTabId[TAB]).toBeUndefined()
  })

  it.each([
    ['foreground server', 'not_idle'],
    ['background watcher', 'not_idle'],
    ['unobservable host', 'unverifiable'],
    ['provider without exact enforcement', 'unsupported'],
    ['remote creator not attested', 'owner_unattested']
  ] as const)(
    'AE6: retains the Setup leaf when the provider reports a %s',
    async (_case, reason) => {
      runtime.providerAnswers.push(() => retainPty(reason))

      await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
        outcome: 'retained',
        blockers: [`provider:${reason}`]
      })
      expect(runtime.removeLeaf).not.toHaveBeenCalled()
      expect(runtime.session).toEqual(initialSession())
      expect(lifecycle.get(PREPARATION_ID)?.state).toBe('observing')
      expect(lifecycle.mayEnqueueSetup(PREPARATION_ID)).toBe(true)
    }
  )

  it('AE6: manual input while waiting for quiescence retains the leaf without a stop', async () => {
    runtime.output()
    runtime.at(100, () => runtime.input())

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['input-changed']
    })
    expect(runtime.retireIdle).not.toHaveBeenCalled()
    expect(runtime.removeLeaf).not.toHaveBeenCalled()
  })

  it('AE6: input the provider saw during its inspection is never retried into a stop', async () => {
    runtime.providerAnswers.push(() => {
      runtime.input()
      return retainPty('input_during_inspection')
    })

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['provider:input_during_inspection']
    })
    expect(runtime.retireIdle).toHaveBeenCalledTimes(1)
    expect(runtime.removeLeaf).not.toHaveBeenCalled()
  })

  it('AE8: incomplete capture retains the leaf and its output without committing or stopping', async () => {
    lifecycle.recordCaptureIncomplete(PREPARATION_ID, 'overflow')

    const verdict = await runtime.retirement().evaluate(PREPARATION_ID)

    expect(verdict).toMatchObject({ outcome: 'retained' })
    expect(verdict.outcome === 'retained' && verdict.blockers).toContain('capture-incomplete')
    expect(runtime.commits).toEqual([])
    expect(runtime.retireIdle).not.toHaveBeenCalled()
    expect(runtime.sessionLeafIds(TAB)).toEqual([SETUP.leafId, AGENT.leafId])
  })

  it('AE8: an archive that could not be committed authorizes no stop', async () => {
    runtime.commitRefusal = { committed: false, reason: 'storage-failed' }

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['archive-uncommitted']
    })
    expect(runtime.retireIdle).not.toHaveBeenCalled()
  })

  it('AE9: a Setup-titled terminal without a registration for this creation is never a candidate', async () => {
    runtime.record = null

    const verdict = await runtime.retirement().evaluate(PREPARATION_ID)

    expect(verdict).toMatchObject({ outcome: 'retained' })
    expect(verdict.outcome === 'retained' && verdict.blockers).toContain('unregistered')
    expect(runtime.commits).toEqual([])
    expect(runtime.retireIdle).not.toHaveBeenCalled()
    expect(runtime.session).toEqual(initialSession())
  })

  it('names every failed eligibility proof at once', async () => {
    runtime.authorized = false
    lifecycle.recordCaptureIncomplete(PREPARATION_ID, 'sequence-gap')

    const verdict = await runtime.retirement().evaluate(PREPARATION_ID)

    expect(verdict).toMatchObject({ outcome: 'retained' })
    expect(verdict.outcome === 'retained' && [...verdict.blockers].sort()).toEqual(
      ['capture-incomplete', 'handoff-unproven'].sort()
    )
    expect(runtime.retireIdle).not.toHaveBeenCalled()
  })

  it('never stops a replacement that took the pane during the archive commit', async () => {
    runtime.onCommit = () => runtime.replace()

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['replaced']
    })
    expect(runtime.retireIdle).not.toHaveBeenCalled()
    expect(runtime.removeLeaf).not.toHaveBeenCalled()
  })

  it('never stops or removes a replacement admitted during provider inspection', async () => {
    runtime.providerAnswers.push(() => {
      runtime.replace()
      return retainPty('incarnation_mismatch')
    })

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['provider:incarnation_mismatch']
    })
    expect(runtime.retireIdle).toHaveBeenCalledTimes(1)
    expect(runtime.removeLeaf).not.toHaveBeenCalled()
    expect(runtime.sessionLeafIds(TAB)).toEqual([SETUP.leafId, AGENT.leafId])
  })

  it('retains when the canonical layout moves the leaf during the commit', async () => {
    runtime.onCommit = () => {
      runtime.setup().layoutRevision += 1
    }

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['layout-changed']
    })
    expect(runtime.retireIdle).not.toHaveBeenCalled()
  })

  it('waits for quiescence, then includes prompt and OSC output from after the marker', async () => {
    runtime.output(40)
    runtime.at(200, () => runtime.output(12))

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retired'
    })
    expect(runtime.commits).toHaveLength(1)
    expect(runtime.commits[0]).toMatchObject({ finalSequence: 172 })
    expect(runtime.now - runtime.setup().lastOutputAt).toBeGreaterThanOrEqual(
      PREPARATION_OUTPUT_QUIESCENCE_MS
    )
  })

  it('supersedes a snapshot invalidated by output right after its commit, and retires once', async () => {
    runtime.onCommit = () => {
      runtime.onCommit = null
      runtime.output(5)
    }

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retired'
    })
    expect(runtime.commits.map((commit) => commit.finalSequence)).toEqual([120, 125])
    expect(runtime.retireIdle).toHaveBeenCalledTimes(1)
    expect(runtime.retireIdle).toHaveBeenCalledWith(
      SETUP.ptyId,
      expect.objectContaining({ expectedOutputChars: 125 })
    )
    expect(runtime.removeLeaf).toHaveBeenCalledTimes(1)
  })

  it('re-snapshots output the provider saw during inspection, then retires', async () => {
    runtime.providerAnswers.push(() => {
      runtime.output(3)
      return retainPty('output_during_inspection')
    })

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retired'
    })
    expect(runtime.commits.map((commit) => commit.finalSequence)).toEqual([120, 123])
    expect(runtime.retireIdle).toHaveBeenCalledTimes(2)
    expect(runtime.removeLeaf).toHaveBeenCalledTimes(1)
  })

  it('gives up after the bounded number of output-only re-snapshots', async () => {
    for (let attempt = 0; attempt <= PREPARATION_MAX_RESNAPSHOTS + 1; attempt += 1) {
      runtime.providerAnswers.push(() => {
        runtime.output(1)
        return retainPty('output_advanced')
      })
    }

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['snapshot-attempts-exhausted']
    })
    expect(runtime.commits).toHaveLength(PREPARATION_MAX_RESNAPSHOTS + 1)
    expect(runtime.removeLeaf).not.toHaveBeenCalled()
    expect(lifecycle.get(PREPARATION_ID)?.state).toBe('observing')
  })

  it('continuously changing output exhausts settlement without closure', async () => {
    runtime.output()
    for (let at = 100; at <= PREPARATION_SETTLEMENT_WINDOW_MS + 1_000; at += 100) {
      runtime.at(at, () => runtime.output())
    }

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['output-unsettled']
    })
    expect(runtime.commits).toEqual([])
    expect(runtime.retireIdle).not.toHaveBeenCalled()
  })

  it('duplicate cleanup events retire once', async () => {
    const retirement = runtime.retirement()

    const verdicts = await Promise.all([
      retirement.evaluate(PREPARATION_ID),
      retirement.evaluate(PREPARATION_ID)
    ])
    const later = await retirement.evaluate(PREPARATION_ID)

    expect(verdicts).toEqual([{ outcome: 'retired' }, { outcome: 'retired' }])
    expect(later).toEqual({ outcome: 'retired' })
    expect(runtime.retireIdle).toHaveBeenCalledTimes(1)
    expect(runtime.commits).toHaveLength(1)
    expect(runtime.sessionLeafIds(TAB)).toEqual([AGENT.leafId])
  })

  it('an unconfirmed stop keeps the occupied pane and never stops again before recovery', async () => {
    runtime.providerAnswers.push(() => ({ outcome: 'unconfirmed' }))
    const retirement = runtime.retirement()

    await expect(retirement.evaluate(PREPARATION_ID)).resolves.toEqual({ outcome: 'unconfirmed' })
    await expect(retirement.evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['close-pending']
    })
    expect(runtime.retireIdle).toHaveBeenCalledTimes(1)
    expect(runtime.removeLeaf).not.toHaveBeenCalled()
    expect(runtime.sessionLeafIds(TAB)).toEqual([SETUP.leafId, AGENT.leafId])
    expect(lifecycle.get(PREPARATION_ID)?.state).toBe('retiring')
  })

  it('a retired preparation is not restored by a later evaluation after restart', async () => {
    await runtime.retirement().evaluate(PREPARATION_ID)
    runtime.retireIdle.mockClear()
    const restarted = new FakeRuntime(
      new PreparationLifecycleStore({ filePath: join(directory, 'lifecycle.json') })
    )
    restarted.session = runtime.session

    await expect(restarted.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retired'
    })
    expect(restarted.retireIdle).not.toHaveBeenCalled()
    expect(restarted.commits).toEqual([])
    expect(restarted.sessionLeafIds(TAB)).toEqual([AGENT.leafId])
  })

  it('a provider stop that throws is unconfirmed: the pane stays and nothing is removed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runtime.retireIdle.mockRejectedValueOnce(new Error('relay disconnected'))

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'unconfirmed'
    })
    expect(runtime.removeLeaf).not.toHaveBeenCalled()
    expect(runtime.sessionLeafIds(TAB)).toEqual([SETUP.leafId, AGENT.leafId])
    expect(lifecycle.get(PREPARATION_ID)?.state).toBe('retiring')
  })

  it.each([
    ['resolves false', async () => false],
    [
      'rejects',
      async (): Promise<boolean> => {
        throw new Error('session write failed')
      }
    ]
  ] as const)(
    'a leaf removal that %s after a confirmed stop keeps the tombstone and later retries removal only',
    async (_case, failingRemoval) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      runtime.removeLeaf.mockImplementationOnce(failingRemoval)
      const retirement = runtime.retirement()

      await expect(retirement.evaluate(PREPARATION_ID)).resolves.toEqual({
        outcome: 'retained',
        blockers: ['leaf-removal-failed']
      })
      // The stop is a fact: the setup may never run again, and the dead leaf is still there.
      expect(lifecycle.get(PREPARATION_ID)?.state).toBe('retired')
      expect(lifecycle.mayEnqueueSetup(PREPARATION_ID)).toBe(false)
      expect(runtime.sessionLeafIds(TAB)).toEqual([SETUP.leafId, AGENT.leafId])

      // Documented recovery: a later evaluation finishes the idempotent removal, never a stop.
      await expect(retirement.evaluate(PREPARATION_ID)).resolves.toEqual({ outcome: 'retired' })
      expect(runtime.retireIdle).toHaveBeenCalledTimes(1)
      expect(runtime.removeLeaf).toHaveBeenCalledTimes(2)
      expect(runtime.sessionLeafIds(TAB)).toEqual([AGENT.leafId])
    }
  )

  it('a takeover revoked while output settles retains the leaf without a commit or stop', async () => {
    runtime.output()
    runtime.at(100, () => {
      runtime.authorized = false
    })

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['handoff-unproven']
    })
    expect(runtime.commits).toEqual([])
    expect(runtime.retireIdle).not.toHaveBeenCalled()
    expect(lifecycle.get(PREPARATION_ID)?.state).toBe('observing')
  })

  it('a takeover revoked during the archive commit never begins the close', async () => {
    runtime.onCommit = () => {
      runtime.authorized = false
    }

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['handoff-unproven']
    })
    expect(runtime.retireIdle).not.toHaveBeenCalled()
    expect(lifecycle.get(PREPARATION_ID)?.state).toBe('observing')
  })

  it('gives the provider stop its own budget when output settles late in the window', async () => {
    runtime.output()
    for (let at = 100; at <= PREPARATION_SETTLEMENT_WINDOW_MS - 400; at += 100) {
      runtime.at(at, () => runtime.output())
    }
    let calledAt = 0
    runtime.providerAnswers.push(() => {
      calledAt = runtime.now
      return { outcome: 'stopped' }
    })

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retired'
    })
    const request = runtime.retireIdle.mock.calls[0]?.[1]
    expect(request?.deadlineMs).toBe(calledAt + PREPARATION_PROVIDER_STOP_BUDGET_MS)
    // A relay or daemon capture may legitimately take the whole ps timeout.
    expect(PREPARATION_PROVIDER_STOP_BUDGET_MS).toBeGreaterThan(PS_TIMEOUT_MS)
  })

  it('a close that cannot be made durable never issues the stop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(lifecycle, 'beginClose').mockImplementationOnce(() => {
      throw new Error('EIO')
    })

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['closure-unauthorized']
    })
    expect(runtime.retireIdle).not.toHaveBeenCalled()
    expect(lifecycle.get(PREPARATION_ID)?.state).toBe('observing')
  })

  it('a lifecycle write that fails after a confirmed stop still removes the dead leaf', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(lifecycle, 'settleClose').mockImplementationOnce(() => {
      throw new Error('ENOSPC')
    })

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retired'
    })
    expect(runtime.removeLeaf).toHaveBeenCalledTimes(1)
    expect(runtime.sessionLeafIds(TAB)).toEqual([AGENT.leafId])
    // Still durably retiring on the exact incarnation: its exit or restart recovery tombstones it.
    expect(lifecycle.get(PREPARATION_ID)).toMatchObject({
      state: 'retiring',
      pendingClose: expect.objectContaining({ incarnationId: SETUP.incarnationId })
    })
  })

  it('a lifecycle write that fails after a retained stop reports the close as pending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runtime.providerAnswers.push(() => retainPty('not_idle'))
    vi.spyOn(lifecycle, 'settleClose').mockImplementationOnce(() => {
      throw new Error('ENOSPC')
    })

    await expect(runtime.retirement().evaluate(PREPARATION_ID)).resolves.toEqual({
      outcome: 'retained',
      blockers: ['close-pending']
    })
    expect(runtime.removeLeaf).not.toHaveBeenCalled()
    expect(lifecycle.get(PREPARATION_ID)?.state).toBe('retiring')
  })
})
