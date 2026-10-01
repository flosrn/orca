import { beforeEach, expect, it, vi } from 'vitest'
import { preparationFacts, resetPreparationObservationsForTests } from './preparation-observation'

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

const WORKTREE_PATH = '/tmp/workspaces/prep-cli-runner'
const RUNNER = '/tmp/repo/.git/orca/setup-runner.sh'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

beforeEach(() => resetPreparationObservationsForTests())

// A plain CLI/desktop create asks for neither receipts nor observation, yet its registered
// preparation must still report the complete runner's outcome under both startup policies.
it.each([
  ['start-immediately', false],
  ['wait-for-setup', true]
])(
  'observes the full runner of a %s CLI create that did not ask for observation',
  async (_policy, waitForAgentStartup) => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi.fn(async (options: { command?: string }) =>
      options.command === 'claude' || options.command?.includes('ORCA_SEQUENCED')
        ? { id: 'pty-cli-agent' }
        : { id: 'pty-cli-setup' }
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    computeWorktreePathMock.mockReturnValue(WORKTREE_PATH)
    ensurePathWithinWorkspaceMock.mockReturnValue(WORKTREE_PATH)
    vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm worktree:setup' } })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: RUNNER,
      envVars: { ORCA_ROOT_PATH: '/tmp/repo', ORCA_WORKTREE_PATH: WORKTREE_PATH },
      ...(waitForAgentStartup ? { waitForAgentStartup: true } : {})
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      { path: WORKTREE_PATH, head: 'def', branch: 'prep-cli', isBare: false, isMainWorktree: false }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'prep-cli',
      setupDecision: 'run',
      startup: { command: 'claude' }
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(runtime.listPreparationRecords()[0]?.preparation?.ptyId).toBe('pty-cli-setup')
    )

    const setupCommand = spawn.mock.calls
      .map(([options]) => options.command ?? '')
      .find((command) => command.includes(RUNNER))
    expect(setupCommand).toContain('__ORCA_SETUP_COMPLETE__')
    const token = setupCommand?.match(UUID)?.[0]
    expect(token).toBeTruthy()
    const [record] = runtime.listPreparationRecords()
    await vi.waitFor(() => {
      runtime.onPtyData(
        'pty-cli-setup',
        `step-3\r\n__ORCA_SETUP_COMPLETE__:${token}:0\r\n$ `,
        Date.now()
      )
      expect(preparationFacts(record!.preparationId).outcome).toMatchObject({ status: 'succeeded' })
    })
  }
)
