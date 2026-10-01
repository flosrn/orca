import { expect, it, vi } from 'vitest'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'

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

const WORKTREE_PATH = '/tmp/workspaces/prep-registration'
const SETUP_MARKER = '__ORCA_SETUP_COMPLETE__:'

it('registers finite preparation before its command runs and never adopts a title-only Setup shell', async () => {
  const runtime = new OrcaRuntimeService(store)
  let recordsAtSetupDelivery: unknown = 'setup command never delivered'
  const spawn = vi.fn(async (options: { command?: string }) => {
    if (options.command?.includes(SETUP_MARKER)) {
      // Delivery of the setup command is the spawn itself; registration must already exist.
      recordsAtSetupDelivery = runtime.listPreparationRecords()
      return { id: 'pty-prep-setup' }
    }
    return { id: options.command === 'claude' ? 'pty-prep-agent' : 'pty-title-shell' }
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-prep-registration' }),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
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
      branch: 'prep-registration',
      isBare: false,
      isMainWorktree: false
    }
  ])

  const result = await runtime.createManagedWorktree({
    repoSelector: 'id:repo-1',
    name: 'prep-registration',
    setupDecision: 'run',
    startup: { command: 'claude' },
    observeSetupCompletion: true,
    awaitTerminalProvisioning: true
  })
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))

  const identityRef = {
    worktreeId: result.worktree.id,
    executionHostId: result.worktree.hostId!,
    instanceId: result.worktree.instanceId!
  }
  const worktreeKey = canonicalWorktreeIdentity(identityRef)
  const records = runtime.listPreparationRecords({ worktreeKey })
  expect(records).toHaveLength(1)
  const [record] = records
  // Identity is host + instance generation; the mutable path/title never participates.
  expect(record.worktree).toEqual({
    key: worktreeKey,
    executionHostId: identityRef.executionHostId,
    instanceId: identityRef.instanceId
  })
  // Preparation and agent bind independently to their acknowledged incarnations.
  expect(record.preparation).toMatchObject({
    handle: result.setupReceipt?.terminalHandle,
    ptyId: 'pty-prep-setup'
  })
  expect(record.agent).toMatchObject({
    handle: result.startupTerminal?.handle,
    ptyId: 'pty-prep-agent'
  })
  expect(recordsAtSetupDelivery).toEqual([
    expect.objectContaining({ preparationId: record.preparationId, worktree: record.worktree })
  ])

  const lookalike = await runtime.createTerminal(`id:${result.worktree.id}`, { title: 'Setup' })
  const after = runtime.listPreparationRecords()
  expect(after).toHaveLength(1)
  expect(after[0]!.preparationId).toBe(record.preparationId)
  expect(after[0]!.preparation).not.toMatchObject({ handle: lookalike.handle })
})
