import { beforeEach, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { resetWorktreeTestSshHostHome } from '../../worktree-removal-test-ssh-host-home'

// Dynamic on purpose: vi.mock fragments must register before fixtures load (mocks, lifecycle, fixtures).
const {
  OrcaRuntimeService,
  getActiveMultiplexerMock,
  getEffectiveHooksFromConfig,
  muxRequestMock,
  registerSshFilesystemProvider,
  registerSshGitProvider,
  shouldRunSetupForCreate,
  unregisterSshFilesystemProvider,
  unregisterSshGitProvider
} = await import('../orca-runtime-test-mocks.spec')
await import('../orca-runtime-test-lifecycle.spec')
const { TEST_REPO_ID, isOriginMainBaseRefProbe, makeWorktreeMeta, store } =
  await import('../orca-runtime-test-fixtures.spec')

// A connected SSH provider always reads the host's `$HOME`; worktree guards refuse without it.
beforeEach(resetWorktreeTestSshHostHome)

it('registers SSH-managed preparation under the execution host and binds both remote panes', async () => {
  const created = {
    path: '/remote/prep-ssh',
    head: 'def',
    branch: 'refs/heads/prep-ssh',
    isBare: false,
    isMainWorktree: false
  }
  const remoteRepo = {
    id: TEST_REPO_ID,
    path: '/remote/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1,
    connectionId: 'ssh-1',
    hookSettings: {
      mode: 'auto' as const,
      setupRunPolicy: 'run-by-default' as const,
      setupAgentStartupPolicy: 'wait-for-setup' as const,
      scripts: { setup: '', archive: '' }
    }
  }
  const metaById: Record<string, ReturnType<typeof makeWorktreeMeta>> = {}
  const remoteStore = {
    ...store,
    getRepos: () => [remoteRepo],
    getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
    setWorktreeMeta: (worktreeId: string, meta: Partial<ReturnType<typeof makeWorktreeMeta>>) => {
      metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
      return metaById[worktreeId]
    }
  }
  const provider = {
    exec: vi.fn(async (args: string[]) => {
      if (args[0] === 'config') {
        return { stdout: 'Remote User\n', stderr: '' }
      }
      if (args[0] === 'branch' || args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'origin/main\n', stderr: '' }
      }
      if (isOriginMainBaseRefProbe(args)) {
        return { stdout: 'main-sha\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-path') {
        return { stdout: '/remote/repo/.git/worktrees/prep-ssh/orca/setup-runner.sh\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        throw new Error('missing local branch')
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    }),
    addWorktree: vi.fn().mockResolvedValue(undefined),
    listWorktrees: vi.fn().mockResolvedValue([created])
  }
  const fsProvider = {
    readFile: vi.fn().mockResolvedValue({ isBinary: false, content: 'hooks:\n' }),
    createDir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined)
  }
  vi.mocked(getEffectiveHooksFromConfig).mockReturnValue({
    scripts: { setup: 'pnpm worktree:setup' }
  })
  vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SSH worktree creation and setup-runner resolution call only exec, addWorktree and listWorktrees on this git fake; any other member would throw, not read a wrong value.
  registerSshGitProvider('ssh-1', provider as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hook discovery and runner-script writes call only readFile, createDir and writeFile on this filesystem fake.
  registerSshFilesystemProvider('ssh-1', fsProvider as never)
  getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime store is the fixture's persisted store with only repo and worktree-meta accessors overridden for the remote repo.
  const runtime = new OrcaRuntimeService(remoteStore as never)
  runtime.setPtyController({
    spawn: vi.fn(async (options: { command?: string }) =>
      options.command?.includes('setup-runner.sh')
        ? { id: 'pty-ssh-setup', incarnationId: 'inc-ssh-setup' }
        : { id: 'pty-ssh-agent', incarnationId: 'inc-ssh-agent' }
    ),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })

  try {
    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'prep-ssh',
      setupDecision: 'run',
      startup: { command: 'claude' },
      observeSetupCompletion: true,
      awaitTerminalProvisioning: true
    })

    const [record] = runtime.listPreparationRecords()
    expect(record?.worktree).toMatchObject({
      executionHostId: result.worktree.hostId ?? getRepoExecutionHostId(remoteRepo),
      instanceId: result.worktree.instanceId
    })
    expect(record?.worktree.executionHostId).not.toBe('local')
    expect(record?.preparation).toMatchObject({
      handle: result.setupReceipt?.terminalHandle,
      ptyId: 'pty-ssh-setup',
      incarnationId: 'inc-ssh-setup'
    })
    expect(record?.agent).toMatchObject({
      handle: result.startupTerminal?.handle,
      ptyId: 'pty-ssh-agent',
      incarnationId: 'inc-ssh-agent'
    })
  } finally {
    unregisterSshGitProvider('ssh-1')
    unregisterSshFilesystemProvider('ssh-1')
  }
})
