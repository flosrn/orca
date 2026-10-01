import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  retainPty,
  type PtyIdleRetirementRequest,
  type PtyIdleRetirementResult
} from '../../../shared/pty-idle-retirement'
import { PREPARATION_BOUNDED_RETRY_ATTEMPTS } from './preparation-retirement-runtime'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { setupCompletionTokens } from './preparation-setup-token-test-access.spec'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

// Dynamic on purpose: vi.mock fragments must register before the runtime fixtures load.
const {
  OrcaRuntimeService,
  computeWorktreePathMock,
  createSetupRunnerScript,
  ensurePathWithinWorkspaceMock,
  getEffectiveHooks,
  listWorktrees,
  shouldRunSetupForCreate
} = await import('../orca-runtime-test-mocks.spec')
await import('../orca-runtime-test-lifecycle.spec')
const { makeRuntimeStoreWithWorkspaceSession } = await import('../orca-runtime-test-fixtures.spec')
const { observeAuthenticatedHookBody, resetPreparationObservationsForTests } =
  await import('./preparation-observation')

const SETUP_MARKER = '__ORCA_SETUP_COMPLETE__:'
const LEGACY_SETUP = { tabId: 'tab-legacy-setup', leafId: 'leaf-legacy', ptyId: 'pty-legacy-setup' }

type SpawnOptions = { command?: string; env?: Record<string, string | undefined> }

const directories: string[] = []

afterEach(() => {
  resetPreparationObservationsForTests()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function terminalTab(
  worktreeId: string,
  id: string,
  ptyId: string,
  title: string,
  sortOrder: number
) {
  return {
    id,
    ptyId,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

async function createRuntimeWithPreparation(label: string) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-preparation-retirement-runtime-'))
  directories.push(directory)
  const persisted = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
  const runtime = new OrcaRuntimeService(persisted.runtimeStore)
  runtime.setPreparationStorage({ directory })
  const setupPtyId = `pty-setup-${label}`
  const agentPtyId = `pty-agent-${label}`
  let agentEnv: Record<string, string | undefined> = {}
  const spawn = vi.fn(async (options: SpawnOptions) => {
    if (options.env?.ORCA_AGENT_LAUNCH_TOKEN) {
      agentEnv = options.env
    }
    if (options.command?.includes(SETUP_MARKER)) {
      return { id: setupPtyId, incarnationId: `inc-setup-${label}` }
    }
    return { id: agentPtyId, incarnationId: `inc-agent-${label}` }
  })
  // Stands in for the verified provider seam: stops only the exact live incarnation it is asked for.
  const retireIdle = vi.fn(
    async (ptyId: string, request: PtyIdleRetirementRequest): Promise<PtyIdleRetirementResult> => {
      runtime.onPtyExit(ptyId, 0, request.expectedIncarnationId, { providerExitObserved: true })
      return { outcome: 'stopped' }
    }
  )
  const kill = vi.fn(() => true)
  const closeTerminal = vi.fn()
  const retireTerminalSurface = vi.fn()
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill,
    getForegroundProcess: async () => null,
    retireIdle,
    inputRevision: () => 0
  })
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn().mockResolvedValue({ tabId: `tab-${label}` }),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal,
    retireTerminalSurface,
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  const path = `/tmp/workspaces/${label}`
  computeWorktreePathMock.mockReturnValue(path)
  ensurePathWithinWorkspaceMock.mockReturnValue(path)
  vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm worktree:setup' } })
  vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
  vi.mocked(createSetupRunnerScript).mockReturnValue({
    runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
    envVars: { ORCA_ROOT_PATH: '/tmp/repo', ORCA_WORKTREE_PATH: path }
  })
  vi.mocked(listWorktrees).mockResolvedValue([
    { path, head: 'def', branch: label, isBare: false, isMainWorktree: false }
  ])
  const created = await runtime.createManagedWorktree({
    repoSelector: 'id:repo-1',
    name: label,
    setupDecision: 'run',
    startup: { command: 'claude' },
    observeSetupCompletion: true,
    awaitTerminalProvisioning: true
  })
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
  const record = runtime.listPreparationRecords().find((entry) => entry.agent?.ptyId === agentPtyId)
  const setup = record?.preparation
  const agent = record?.agent
  if (!record || !setup?.tabId || !setup.leafId || !agent?.leafId) {
    throw new Error('preparation panes were not bound')
  }
  const worktreeId = created.worktree.id
  // Hidden split: Setup and OMP share one persisted tab no renderer has mounted, next to an
  // unrelated old terminal titled `Setup` that no registration of this creation owns.
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: [
        terminalTab(worktreeId, setup.tabId, setup.ptyId, 'Setup', 0),
        terminalTab(worktreeId, LEGACY_SETUP.tabId, LEGACY_SETUP.ptyId, 'Setup', 1)
      ]
    },
    terminalLayoutsByTabId: {
      [setup.tabId]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: setup.leafId },
          second: { type: 'leaf', leafId: agent.leafId }
        },
        activeLeafId: agent.leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [setup.leafId]: setup.ptyId, [agent.leafId]: agent.ptyId }
      },
      [LEGACY_SETUP.tabId]: {
        root: { type: 'leaf', leafId: LEGACY_SETUP.leafId },
        activeLeafId: LEGACY_SETUP.leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEGACY_SETUP.leafId]: LEGACY_SETUP.ptyId }
      }
    }
  }
  persisted.setSession(session)
  const token = setupCompletionTokens(runtime).get(setupPtyId)
  return {
    directory,
    worktreeId,
    runtime,
    persisted,
    record,
    setup,
    agent,
    agentEnv,
    token,
    retireIdle,
    kill,
    closeTerminal,
    retireTerminalSurface
  }
}

function takeover(paneKey: string, launchToken: string): void {
  observeAuthenticatedHookBody(
    {
      paneKey,
      launchToken,
      payload: {
        hook_event_name: 'session_start',
        root_session_ready: true,
        root_session_id: 'root-session-1',
        status_owner_module: '/opt/orca/extensions/orca-agent-status.ts'
      }
    },
    true
  )
}

it('AE5/AE9: retires only the hidden Setup leaf after success and takeover, and never a title-only Setup', async () => {
  const prepared = await createRuntimeWithPreparation('prep-retire-ae5')
  const { runtime, persisted, setup, agent } = prepared
  expect(prepared.token).toEqual(expect.any(String))

  runtime.onPtyData(setup.ptyId, 'installing\n', Date.now())
  runtime.onPtyData(setup.ptyId, `${SETUP_MARKER}${prepared.token}:0\r\n$ `, Date.now())
  expect(prepared.retireIdle).not.toHaveBeenCalled()
  takeover(prepared.agentEnv.ORCA_PANE_KEY!, prepared.agentEnv.ORCA_AGENT_LAUNCH_TOKEN!)

  await vi.waitFor(
    () => expect(runtime.mayEnqueuePreparationSetup(prepared.record.preparationId)).toBe(false),
    { timeout: 3_000 }
  )
  expect(prepared.retireIdle).toHaveBeenCalledTimes(1)
  expect(prepared.retireIdle).toHaveBeenCalledWith(
    setup.ptyId,
    expect.objectContaining({ expectedIncarnationId: setup.incarnationId })
  )
  expect(prepared.kill).not.toHaveBeenCalled()
  const session = persisted.getSession()
  const worktreeTabs = Object.values(session.tabsByWorktree).flat()
  expect(worktreeTabs.map((tab) => tab.id).sort()).toEqual([LEGACY_SETUP.tabId, setup.tabId].sort())
  expect(agent.leafId).not.toBeNull()
  expect(setup.tabId).not.toBeNull()
  expect(session.terminalLayoutsByTabId[String(setup.tabId)]?.ptyIdsByLeafId).toEqual({
    [String(agent.leafId)]: agent.ptyId
  })
  expect(session.terminalLayoutsByTabId[LEGACY_SETUP.tabId]?.ptyIdsByLeafId).toEqual({
    [LEGACY_SETUP.leafId]: LEGACY_SETUP.ptyId
  })
  // The renderer mirrors the exact leaf removal; a tab-id close would take OMP with it.
  expect(prepared.closeTerminal).not.toHaveBeenCalled()
  expect(prepared.retireTerminalSurface).toHaveBeenCalledWith({
    tabId: setup.tabId,
    leafId: setup.leafId,
    ptyId: setup.ptyId
  })

  // Duplicate cleanup facts after retirement never stop again.
  takeover(prepared.agentEnv.ORCA_PANE_KEY!, prepared.agentEnv.ORCA_AGENT_LAUNCH_TOKEN!)
  await expect(
    runtime.evaluatePreparationRetirement(prepared.record.preparationId)
  ).resolves.toEqual({ outcome: 'retired' })
  expect(prepared.retireIdle).toHaveBeenCalledTimes(1)

  // Restart: in-memory registrations are gone, but the durable tombstone still forbids any
  // runtime-created spawn of the retired preparation role, and nothing is stopped again.
  const restarted = new OrcaRuntimeService(persisted.runtimeStore)
  restarted.setPreparationStorage({ directory: prepared.directory })
  const restartedSpawn = vi.fn(async () => ({ id: 'pty-rerun', incarnationId: 'inc-rerun' }))
  const restartedRetireIdle = vi.fn()
  restarted.setPtyController({
    spawn: restartedSpawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    retireIdle: restartedRetireIdle,
    inputRevision: () => 0
  })
  expect(restarted.mayEnqueuePreparationSetup(prepared.record.preparationId)).toBe(false)
  await expect(
    restarted.createTerminal(`id:${prepared.worktreeId}`, {
      preparation: { preparationId: prepared.record.preparationId, role: 'preparation' }
    })
  ).rejects.toThrow('preparation_retired')
  expect(restartedSpawn).not.toHaveBeenCalled()
  await expect(
    restarted.evaluatePreparationRetirement(prepared.record.preparationId)
  ).resolves.toEqual({ outcome: 'retained', blockers: ['unregistered'] })
  expect(restartedRetireIdle).not.toHaveBeenCalled()
})

it('AE9: a terminal titled Setup without this creation`s registration is never evaluated or stopped', async () => {
  const prepared = await createRuntimeWithPreparation('prep-retire-ae9')
  const before = prepared.persisted.getSession()

  await expect(prepared.runtime.evaluatePreparationRetirement('title-setup')).resolves.toEqual({
    outcome: 'retained',
    blockers: ['unregistered']
  })
  // Registered, but the runner never reported success and no agent took over.
  await expect(
    prepared.runtime.evaluatePreparationRetirement(prepared.record.preparationId)
  ).resolves.toMatchObject({ outcome: 'retained', blockers: ['handoff-unproven'] })
  expect(prepared.retireIdle).not.toHaveBeenCalled()
  expect(prepared.kill).not.toHaveBeenCalled()
  expect(prepared.persisted.getSession()).toEqual(before)
})

/** Runner success plus takeover: the facts that start an automatic evaluation. */
function completeAndTakeOver(
  runtime: InstanceType<typeof OrcaRuntimeService>,
  setupPtyId: string,
  token: string | undefined,
  agentEnv: Record<string, string | undefined>
): void {
  runtime.onPtyData(setupPtyId, 'installing\n', Date.now())
  runtime.onPtyData(setupPtyId, `${SETUP_MARKER}${token}:0\r\n$ `, Date.now())
  takeover(agentEnv.ORCA_PANE_KEY!, agentEnv.ORCA_AGENT_LAUNCH_TOKEN!)
}

function leafIds(session: WorkspaceSessionState, tabId: string | null): string[] {
  return Object.keys(session.terminalLayoutsByTabId[String(tabId)]?.ptyIdsByLeafId ?? {})
}

it('an unconfirmed stop is reconciled in-process when the exact incarnation exits', async () => {
  const prepared = await createRuntimeWithPreparation('prep-retire-unconfirmed-exit')
  const { runtime, setup, agent, persisted } = prepared
  prepared.retireIdle.mockImplementationOnce(async () => ({ outcome: 'unconfirmed' as const }))
  completeAndTakeOver(runtime, setup.ptyId, prepared.token, prepared.agentEnv)

  await vi.waitFor(() => expect(prepared.retireIdle).toHaveBeenCalledTimes(1), { timeout: 3_000 })
  await expect(
    runtime.evaluatePreparationRetirement(prepared.record.preparationId)
  ).resolves.toEqual({ outcome: 'retained', blockers: ['close-pending'] })
  expect(leafIds(persisted.getSession(), setup.tabId)).toContain(setup.leafId)

  // The relay's stop applied after all: the exact recorded incarnation exits.
  runtime.onPtyExit(setup.ptyId, 0, setup.incarnationId ?? undefined, {
    providerExitObserved: true
  })

  await vi.waitFor(
    () => expect(leafIds(persisted.getSession(), setup.tabId)).toEqual([agent.leafId]),
    { timeout: 3_000 }
  )
  expect(runtime.mayEnqueuePreparationSetup(prepared.record.preparationId)).toBe(false)
  await expect(
    runtime.evaluatePreparationRetirement(prepared.record.preparationId)
  ).resolves.toEqual({ outcome: 'retired' })
  expect(prepared.retireIdle).toHaveBeenCalledTimes(1)
})

it('a leaf removal whose persistence fails is retried after the confirmed stop, never re-stopped', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const prepared = await createRuntimeWithPreparation('prep-retire-removal-retry')
  const { runtime, setup, agent, persisted } = prepared
  let diskFull = true
  persisted.runtimeStore.setWorkspaceSession.mockImplementation((session) => {
    if (diskFull) {
      throw new Error('disk full')
    }
    persisted.setSession(session)
  })
  completeAndTakeOver(runtime, setup.ptyId, prepared.token, prepared.agentEnv)

  await vi.waitFor(() => expect(prepared.retireIdle).toHaveBeenCalledTimes(1), { timeout: 3_000 })
  await expect(
    runtime.evaluatePreparationRetirement(prepared.record.preparationId)
  ).resolves.toEqual({ outcome: 'retained', blockers: ['leaf-removal-failed'] })
  // The setup is dead and tombstoned; only its leaf is still persisted.
  expect(runtime.mayEnqueuePreparationSetup(prepared.record.preparationId)).toBe(false)
  expect(leafIds(persisted.getSession(), setup.tabId)).toContain(setup.leafId)

  diskFull = false
  await vi.waitFor(
    () => expect(leafIds(persisted.getSession(), setup.tabId)).toEqual([agent.leafId]),
    { timeout: 3_000 }
  )
  expect(prepared.retireIdle).toHaveBeenCalledTimes(1)
  errors.mockRestore()
})

it('a transient unverifiable provider answer is retried once output stays quiet', async () => {
  const prepared = await createRuntimeWithPreparation('prep-retire-unverifiable-retry')
  const { runtime, setup, agent, persisted } = prepared
  prepared.retireIdle.mockImplementationOnce(async () => retainPty('unverifiable'))
  completeAndTakeOver(runtime, setup.ptyId, prepared.token, prepared.agentEnv)

  await vi.waitFor(
    () => expect(leafIds(persisted.getSession(), setup.tabId)).toEqual([agent.leafId]),
    { timeout: 3_000 }
  )
  expect(prepared.retireIdle).toHaveBeenCalledTimes(2)
  expect(runtime.mayEnqueuePreparationSetup(prepared.record.preparationId)).toBe(false)
})

it('a persistently unverifiable host keeps the leaf after a bounded number of attempts', async () => {
  const prepared = await createRuntimeWithPreparation('prep-retire-unverifiable-bound')
  const { runtime, setup, persisted } = prepared
  prepared.retireIdle.mockImplementation(async () => retainPty('unverifiable'))
  completeAndTakeOver(runtime, setup.ptyId, prepared.token, prepared.agentEnv)

  await vi.waitFor(
    () => expect(prepared.retireIdle).toHaveBeenCalledTimes(PREPARATION_BOUNDED_RETRY_ATTEMPTS),
    { timeout: 5_000 }
  )
  // Final once the bound is spent: further facts never issue another stop.
  await expect(
    runtime.evaluatePreparationRetirement(prepared.record.preparationId)
  ).resolves.toEqual({ outcome: 'retained', blockers: ['provider:unverifiable'] })
  takeover(prepared.agentEnv.ORCA_PANE_KEY!, prepared.agentEnv.ORCA_AGENT_LAUNCH_TOKEN!)
  await runtime.evaluatePreparationRetirement(prepared.record.preparationId)
  expect(prepared.retireIdle).toHaveBeenCalledTimes(PREPARATION_BOUNDED_RETRY_ATTEMPTS)
  expect(leafIds(persisted.getSession(), setup.tabId)).toContain(setup.leafId)
})
