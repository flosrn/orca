import type { WorktreeSetupLaunch } from '../../../shared/worktree/launch-types'
import { expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PreparationRecord } from '../../../shared/preparation-contracts'

// Dynamic on purpose: vi.mock fragments must register before fixtures load (mocks, lifecycle, fixtures).
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
const { store } = await import('../orca-runtime-test-fixtures.spec')

const WORKTREE_PATH = '/tmp/workspaces/prep-fences'
const SETUP_MARKER = '__ORCA_SETUP_COMPLETE__:'

async function createWithSetup(
  setupScriptLaunchMode: GlobalSettings['setupScriptLaunchMode']
): Promise<{
  runtime: InstanceType<typeof OrcaRuntimeService>
  record: PreparationRecord
  worktreeId: string
}> {
  const runtime = new OrcaRuntimeService({
    ...store,
    getSettings: () => ({ ...store.getSettings(), setupScriptLaunchMode })
  })
  runtime.setPtyController({
    spawn: vi.fn(async (options: { command?: string }) =>
      options.command?.includes(SETUP_MARKER)
        ? { id: 'pty-fence-setup', incarnationId: 'inc-fence-setup' }
        : { id: 'pty-fence-agent', incarnationId: 'inc-fence-agent' }
    ),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  computeWorktreePathMock.mockReturnValue(WORKTREE_PATH)
  ensurePathWithinWorkspaceMock.mockReturnValue(WORKTREE_PATH)
  vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm worktree:setup' } })
  vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
  vi.mocked(createSetupRunnerScript).mockReturnValue({
    runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
    envVars: { ORCA_ROOT_PATH: '/tmp/repo', ORCA_WORKTREE_PATH: WORKTREE_PATH }
  })
  vi.mocked(listWorktrees).mockResolvedValue([
    {
      path: WORKTREE_PATH,
      head: 'def',
      branch: 'prep-fences',
      isBare: false,
      isMainWorktree: false
    }
  ])
  const result = await runtime.createManagedWorktree({
    repoSelector: 'id:repo-1',
    name: 'prep-fences',
    setupDecision: 'run',
    startup: { command: 'claude' },
    observeSetupCompletion: true,
    awaitTerminalProvisioning: true
  })
  const [record] = runtime.listPreparationRecords()
  if (!record) {
    throw new Error('no preparation registered')
  }
  return { runtime, record, worktreeId: result.worktree.id }
}

it('binds a split setup to its own leaf beside the agent pane it split from', async () => {
  const { record } = await createWithSetup('split-vertical')

  expect(record.preparation).toMatchObject({
    ptyId: 'pty-fence-setup',
    incarnationId: 'inc-fence-setup'
  })
  expect(record.agent).toMatchObject({ ptyId: 'pty-fence-agent', incarnationId: 'inc-fence-agent' })
  expect(record.preparation?.tabId).toBe(record.agent?.tabId)
  expect(record.preparation?.leafId).not.toBe(record.agent?.leafId)
  expect(record.preparation?.handle).not.toBe(record.agent?.handle)
})

it('reattaches the same incarnation but never lets a replacement inherit the role', async () => {
  const { runtime, record, worktreeId } = await createWithSetup('new-tab')
  const bound = record.preparation
  if (!bound) {
    throw new Error('preparation pane was not bound')
  }
  const intake = { preparationId: record.preparationId, role: 'preparation' as const }

  expect(runtime.bindPreparationPane(intake, worktreeId, { ...bound })).toBe(true)
  expect(
    runtime.bindPreparationPane(intake, worktreeId, {
      ...bound,
      ptyId: 'pty-fence-replacement',
      incarnationId: 'inc-fence-replacement'
    })
  ).toBe(false)
  expect(
    runtime.reservePreparationPane(intake, worktreeId, {
      handle: 'term_replacement',
      tabId: bound.tabId,
      leafId: bound.leafId
    })
  ).toBe(false)
  // A spawn from another checkout cannot claim a role that is still open.
  const open = runtime.registerWorktreePreparation<WorktreeSetupLaunch>(
    {
      id: worktreeId,
      hostId: record.worktree.executionHostId,
      instanceId: record.worktree.instanceId
    },
    { runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh', envVars: {} }
  )?.preparation
  expect(open).toBeDefined()
  expect(
    runtime.reservePreparationPane(
      { preparationId: open!.preparationId, role: 'preparation' },
      'repo-1::/tmp/workspaces/other',
      { handle: 'term_foreign', tabId: null, leafId: null }
    )
  ).toBe(false)
  expect(runtime.listPreparationRecords()).toContainEqual(
    expect.objectContaining({
      preparationId: record.preparationId,
      preparation: bound,
      agent: record.agent
    })
  )
})
