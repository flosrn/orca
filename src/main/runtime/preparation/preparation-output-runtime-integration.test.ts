import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { readArchiveText } from './preparation-recovery'

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

const WORKTREE_PATH = '/tmp/workspaces/prep-output-runtime'
const SETUP_MARKER = '__ORCA_SETUP_COMPLETE__:'

it('archives setup output the provider streamed before its spawn reply, and reads it after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-preparation-runtime-integration-'))
  try {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPreparationStorage({ directory })
    const spawn = vi.fn(async (options: { command?: string }) => {
      if (options.command?.includes(SETUP_MARKER)) {
        // The stream races the spawn reply: bytes land before the incarnation is acknowledged.
        runtime.onPtyData('pty-prep-setup', 'first-provider-byte\n', Date.now())
        runtime.onPtyData('pty-prep-setup', 'installing\n', Date.now())
        return { id: 'pty-prep-setup', incarnationId: 'inc-setup' }
      }
      return { id: 'pty-prep-agent', incarnationId: 'inc-agent' }
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
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-prep-output' }),
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
        branch: 'prep-output-runtime',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'prep-output-runtime',
      setupDecision: 'run',
      startup: { command: 'claude' },
      observeSetupCompletion: true,
      awaitTerminalProvisioning: true
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    runtime.onPtyData('pty-prep-setup', 'done\n$ ', Date.now())

    const [record] = runtime.listPreparationRecords()
    expect(record?.preparation).toMatchObject({ ptyId: 'pty-prep-setup' })
    const committed = runtime.commitPreparationOutput({
      preparationId: record!.preparationId,
      inputRevision: 0
    })
    expect(committed).toMatchObject({ committed: true })
    if (!committed.committed) {
      return
    }

    const restarted = new OrcaRuntimeService(store)
    restarted.setPreparationStorage({ directory })
    const archive = restarted.getPreparationOutputStore()
    expect(archive).not.toBeNull()
    expect(readArchiveText(archive!, committed.archiveId)).toBe(
      'first-provider-byte\ninstalling\ndone\n$ '
    )
    expect(spawn).toHaveBeenCalledTimes(2)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
