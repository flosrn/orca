import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV } from '../../shared/setup-agent-sequencing'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  listWorktreesMock,
  addWorktreeMock,
  getEffectiveHooksMock,
  createSetupRunnerScriptMock,
  getEffectiveHooksFromConfigMock,
  shouldRunSetupForCreateMock,
  loadHooksMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

const WORKTREE_PATH = '/workspace/improve-dashboard'
const WORKTREE_SELECTOR = `id:repo-1::${WORKTREE_PATH}`
const RUNNER = '/workspace/repo/.git/orca/setup-runner.sh'

function arrangeCreatedWorktreeWithSetup(waitForAgentStartup: boolean): void {
  addWorktreeMock.mockResolvedValue({})
  listWorktreesMock.mockResolvedValueOnce([
    {
      path: WORKTREE_PATH,
      head: 'def',
      branch: 'improve-dashboard',
      isBare: false,
      isMainWorktree: false
    }
  ])
  loadHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
  getEffectiveHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
  getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
  shouldRunSetupForCreateMock.mockReturnValue(true)
  createSetupRunnerScriptMock.mockReturnValueOnce({
    runnerScriptPath: RUNNER,
    envVars: { ORCA_ROOT_PATH: '/workspace/repo', ORCA_WORKTREE_PATH: WORKTREE_PATH },
    ...(waitForAgentStartup ? { waitForAgentStartup: true } : {})
  })
}

async function createManually(): Promise<void> {
  await handlers['worktrees:create'](null, {
    repoId: 'repo-1',
    name: 'improve-dashboard',
    createdWithAgent: 'claude',
    startup: { command: 'claude --prefill test' }
  })
}

// Manual desktop creation must hand its Setup pane to the same runtime provisioning the worker and
// CLI paths use, so the full-runner completion token is recorded for exactly that pane.
describe('manual local worktree creation setup observation', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
    runtimeStub.createTerminal.mockResolvedValue({
      handle: 'term-startup',
      worktreeId: `repo-1::${WORKTREE_PATH}`,
      title: null,
      surface: 'visible'
    })
  })

  it('observes the sequenced runner under the nonce the agent gate waits on', async () => {
    arrangeCreatedWorktreeWithSetup(true)
    let startupEnv: Record<string, string> | undefined
    runtimeStub.createTerminal.mockImplementationOnce(
      async (_selector: string, options: { env?: Record<string, string> }) => {
        startupEnv = options.env
        return { handle: 'term-startup', surface: 'visible' }
      }
    )

    await createManually()

    const nonce = startupEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]?.match(
      /if \[ "\$seen" = ([0-9a-f-]+) \]/
    )?.[1]
    expect(nonce).toBeTruthy()
    expect(runtimeStub.provisionManagedWorktreeTerminals).toHaveBeenCalledOnce()
    expect(runtimeStub.provisionManagedWorktreeTerminals).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSelector: WORKTREE_SELECTOR,
        primaryTerminalHandle: 'term-startup',
        hasStartupTerminal: true,
        observeSetupCompletion: true,
        wrappedSetupCommand: expect.stringContaining(`${nonce} "$status"`),
        wrappedSetupCompletionToken: nonce
      })
    )
    // The Setup pane exists once: provisioning spawns it, not a second direct create.
    expect(runtimeStub.createTerminal).toHaveBeenCalledOnce()
  })

  it('observes an unsequenced runner through a provisioning-minted token', async () => {
    arrangeCreatedWorktreeWithSetup(false)

    await createManually()

    expect(runtimeStub.provisionManagedWorktreeTerminals).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSelector: WORKTREE_SELECTOR,
        observeSetupCompletion: true,
        setup: expect.objectContaining({ runnerScriptPath: RUNNER })
      })
    )
    expect(runtimeStub.provisionManagedWorktreeTerminals).not.toHaveBeenCalledWith(
      expect.objectContaining({ wrappedSetupCommand: expect.anything() })
    )
  })

  it('registers the preparation before the agent pane spawns and hands both roles the same id', async () => {
    arrangeCreatedWorktreeWithSetup(false)
    // Why: like the real store, persisting returns the written metadata, including the fresh instance id.
    store.setWorktreeMeta.mockImplementation(
      (_worktreeId: string, meta: Partial<WorktreeMeta>) => meta
    )
    runtimeStub.registerWorktreePreparation.mockImplementationOnce(
      (_worktree: unknown, setup: Record<string, unknown> | undefined) =>
        setup ? { ...setup, preparation: { preparationId: 'prep-manual' } } : setup
    )

    await createManually()

    expect(runtimeStub.registerWorktreePreparation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `repo-1::${WORKTREE_PATH}`,
        instanceId: expect.any(String),
        hostId: 'local'
      }),
      expect.objectContaining({ runnerScriptPath: RUNNER })
    )
    expect(runtimeStub.registerWorktreePreparation.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeStub.createTerminal.mock.invocationCallOrder[0] ?? 0
    )
    expect(runtimeStub.createTerminal).toHaveBeenCalledWith(
      WORKTREE_SELECTOR,
      expect.objectContaining({ preparation: { preparationId: 'prep-manual', role: 'agent' } })
    )
    expect(runtimeStub.provisionManagedWorktreeTerminals).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: expect.objectContaining({ preparation: { preparationId: 'prep-manual' } })
      })
    )
  })
})
