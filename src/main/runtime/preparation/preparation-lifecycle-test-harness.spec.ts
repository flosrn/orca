import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi, type Mock } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { PreparationPaneBinding } from '../../../shared/preparation-contracts'
import type {
  PtyIdleRetirementRequest,
  PtyIdleRetirementResult
} from '../../../shared/pty-idle-retirement'
import {
  createSequencedSetupAgentCommands,
  createSetupAgentSequenceNonce
} from '../../../shared/setup-agent-sequencing'
import { SETUP_COMPLETION_PREFIX } from '../../../shared/setup-completion-marker'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorktreeSetupLaunch } from '../../../shared/worktree/launch-types'
import { resetWorktreeTestSshHostHome } from '../../worktree-removal-test-ssh-host-home'
import { readArchiveText } from './preparation-recovery'
import { setupCompletionTokens } from './preparation-setup-token-test-access.spec'

// Dynamic on purpose: the importing suite's vi.mock fragments must register before the runtime
// fixtures load, so this harness is itself imported dynamically after them.
const {
  OrcaRuntimeService,
  computeWorktreePathMock,
  createSetupRunnerScript,
  ensurePathWithinWorkspaceMock,
  getActiveMultiplexerMock,
  getEffectiveHooks,
  getEffectiveHooksFromConfig,
  listWorktrees,
  muxRequestMock,
  registerSshFilesystemProvider,
  registerSshGitProvider,
  shouldRunSetupForCreate,
  unregisterSshFilesystemProvider,
  unregisterSshGitProvider
} = await import('../orca-runtime-test-mocks.spec')
await import('../orca-runtime-test-lifecycle.spec')
const {
  TEST_REPO_ID,
  isOriginMainBaseRefProbe,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorktreeMeta
} = await import('../orca-runtime-test-fixtures.spec')
const { observeAuthenticatedHookBody, resetPreparationObservationsForTests } =
  await import('./preparation-observation')

/**
 * Harness for preparation-lifecycle.integration.test.ts: real OrcaRuntimeService creation paths
 * (worker, desktop/manual, SSH) over a stand-in execution host that spawns, counts input and
 * answers the exact idle stop, plus the persisted session the renderer would restore.
 */

export const RUNNER = '/tmp/repo/.git/orca/setup-runner.sh'
const STATUS_OWNER_MODULE = '/opt/orca/extensions/orca-agent-status.ts'
export const RETIREMENT_TIMEOUT_MS = 3_000

type Surface = 'worker' | 'manual'
type StartupPolicy = 'start-immediately' | 'wait-for-setup'
type SpawnOptions = {
  command?: string
  env?: Record<string, string | undefined>
  preparation?: { preparationId: string; role: string }
}
type ProviderAnswer = (
  ptyId: string,
  request: PtyIdleRetirementRequest
) => Promise<PtyIdleRetirementResult>
type RuntimeStoreArg = ConstructorParameters<typeof OrcaRuntimeService>[0]
type SessionTab = WorkspaceSessionState['tabsByWorktree'][string][number]
type SessionLayout = WorkspaceSessionState['terminalLayoutsByTabId'][string]
type BoundPane = PreparationPaneBinding & { tabId: string; leafId: string; incarnationId: string }

const directories: string[] = []
const sshConnections: string[] = []

/** Per-test reset: SSH host home, observation facts, SSH providers and archive directories. */
export function resetPreparationLifecycleHarness(): void {
  resetPreparationObservationsForTests()
  // A connected SSH provider always reads the host's `$HOME`; worktree guards refuse without it.
  resetWorktreeTestSshHostHome()
  for (const connectionId of sshConnections.splice(0)) {
    unregisterSshGitProvider(connectionId)
    unregisterSshFilesystemProvider(connectionId)
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
}

function storageDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-preparation-lifecycle-'))
  directories.push(directory)
  return directory
}

/** Stands in for the execution host: spawns, counts input, and answers the exact idle stop. */
export function installRuntime(
  label: string,
  runtimeStore: RuntimeStoreArg,
  directory: string
): InstalledRuntime {
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPreparationStorage({ directory })
  const spawned: InstalledRuntime['spawned'] = { agentEnv: {}, extras: [] }
  const spawn = vi.fn(async (options: SpawnOptions) => {
    if (options.preparation?.role === 'agent') {
      spawned.agentEnv = options.env ?? {}
      return { id: `pty-agent-${label}`, incarnationId: `inc-agent-${label}` }
    }
    if (options.preparation?.role === 'preparation') {
      return { id: `pty-setup-${label}`, incarnationId: `inc-setup-${label}` }
    }
    const id = `pty-extra-${label}-${spawned.extras.length}`
    spawned.extras.push(id)
    return { id, incarnationId: `inc-${id}` }
  })
  const inputs = new Map<string, number>()
  // Default host answer: the shell is bare, so the exact incarnation stops and physically exits.
  // Liveness readback after restart defaults to unknown, never absent.
  const provider: InstalledRuntime['provider'] = {
    answer: async (ptyId, request) => {
      runtime.onPtyExit(ptyId, 0, request.expectedIncarnationId, { providerExitObserved: true })
      return { outcome: 'stopped' }
    },
    liveness: async () => null
  }
  const retireIdle = vi.fn((ptyId: string, request: PtyIdleRetirementRequest) =>
    provider.answer(ptyId, request)
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
    inputRevision: (ptyId: string) => inputs.get(ptyId) ?? 0,
    probePtyLiveness: (ptyId: string) => provider.liveness(ptyId)
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
  return {
    runtime,
    spawn,
    spawned,
    inputs,
    provider,
    retireIdle,
    kill,
    closeTerminal,
    retireTerminalSurface
  }
}

type InstalledRuntime = {
  runtime: InstanceType<typeof OrcaRuntimeService>
  spawn: Mock<(options: SpawnOptions) => Promise<{ id: string; incarnationId: string }>>
  spawned: { agentEnv: Record<string, string | undefined>; extras: string[] }
  inputs: Map<string, number>
  provider: { answer: ProviderAnswer; liveness: (ptyId: string) => Promise<boolean | null> }
  retireIdle: Mock<ProviderAnswer>
  kill: Mock<() => boolean>
  closeTerminal: Mock
  retireTerminalSurface: Mock
}

function requireBound(pane: PreparationPaneBinding | null | undefined, role: string): BoundPane {
  if (!pane?.tabId || !pane.leafId || !pane.incarnationId) {
    throw new Error(`${role} pane was not bound to an exact incarnation`)
  }
  return { ...pane, tabId: pane.tabId, leafId: pane.leafId, incarnationId: pane.incarnationId }
}

async function bindCreatedPreparation(
  installed: InstalledRuntime,
  label: string,
  worktreeId: string
) {
  const { runtime } = installed
  const setupPtyId = `pty-setup-${label}`
  // Why: the runner nonce is private runtime state; the test prints the marker the host would.
  const tokens = setupCompletionTokens(runtime)
  await vi.waitFor(() => {
    const record = runtime
      .listPreparationRecords()
      .find((entry) => entry.agent?.ptyId === `pty-agent-${label}`)
    expect(record?.preparation?.ptyId).toBe(setupPtyId)
    expect(tokens.get(setupPtyId)).toEqual(expect.any(String))
  })
  const record = runtime
    .listPreparationRecords()
    .find((entry) => entry.agent?.ptyId === `pty-agent-${label}`)!
  return {
    worktreeId,
    record,
    preparationId: record.preparationId,
    setup: requireBound(record.preparation, 'preparation'),
    agent: requireBound(record.agent, 'agent'),
    token: tokens.get(setupPtyId)!
  }
}

/** Desktop creation: the IPC handler registers, spawns the agent, then hands setup to provisioning. */
async function createManually(
  installed: InstalledRuntime,
  label: string,
  path: string,
  launch: WorktreeSetupLaunch,
  policy: StartupPolicy
): Promise<string> {
  const { runtime } = installed
  vi.mocked(shouldRunSetupForCreate).mockReturnValue(false)
  const created = await runtime.createManagedWorktree({
    repoSelector: 'id:repo-1',
    name: label,
    setupDecision: 'skip',
    awaitTerminalProvisioning: true
  })
  const { id, hostId, instanceId } = created.worktree
  const setup = runtime.registerWorktreePreparation<WorktreeSetupLaunch>(
    { id, hostId, instanceId },
    launch
  )
  const preparationId = setup?.preparation?.preparationId
  if (!setup || !preparationId) {
    throw new Error('manual creation registered no preparation')
  }
  // Same wrapper the desktop handler builds: the agent gate and the Setup pane share one nonce.
  const nonce = policy === 'wait-for-setup' ? createSetupAgentSequenceNonce() : null
  const sequenced = nonce
    ? createSequencedSetupAgentCommands({
        runnerScriptPath: RUNNER,
        startupCommand: 'claude',
        platform: 'posix',
        nonce
      })
    : null
  const agent = await runtime.createTerminal(`id:${id}`, {
    command: sequenced?.startupCommand ?? 'claude',
    ...(sequenced?.startupEnv ? { env: sequenced.startupEnv } : {}),
    activate: true,
    preparation: { preparationId, role: 'agent' }
  })
  await runtime.provisionManagedWorktreeTerminals({
    worktreeSelector: `id:${id}`,
    worktreeId: id,
    worktreePath: path,
    setup,
    primaryTerminalHandle: agent.handle,
    hasStartupTerminal: true,
    setupCommandPlatform: 'posix',
    observeSetupCompletion: true,
    ...(sequenced && nonce
      ? { wrappedSetupCommand: sequenced.setupCommand, wrappedSetupCompletionToken: nonce }
      : {})
  })
  return id
}

export async function createLocalPreparation(options: {
  label: string
  surface: Surface
  policy: StartupPolicy
}): Promise<Prepared> {
  const { label, surface, policy } = options
  const directory = storageDirectory()
  const persisted = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
  const installed = installRuntime(label, persisted.runtimeStore, directory)
  const path = `/tmp/workspaces/${label}`
  computeWorktreePathMock.mockReturnValue(path)
  ensurePathWithinWorkspaceMock.mockReturnValue(path)
  vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm worktree:setup' } })
  vi.mocked(listWorktrees).mockResolvedValue([
    { path, head: 'def', branch: label, isBare: false, isMainWorktree: false }
  ])
  const launch: WorktreeSetupLaunch = {
    runnerScriptPath: RUNNER,
    envVars: { ORCA_ROOT_PATH: '/tmp/repo', ORCA_WORKTREE_PATH: path },
    ...(policy === 'wait-for-setup' ? { waitForAgentStartup: true } : {})
  }
  let worktreeId: string
  if (surface === 'worker') {
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue(launch)
    const created = await installed.runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: label,
      setupDecision: 'run',
      startup: { command: 'claude' },
      observeSetupCompletion: true,
      awaitTerminalProvisioning: true
    })
    worktreeId = created.worktree.id
  } else {
    worktreeId = await createManually(installed, label, path, launch, policy)
  }
  return {
    ...installed,
    directory,
    persisted,
    ...(await bindCreatedPreparation(installed, label, worktreeId))
  }
}

export async function createSshPreparation(
  label: string,
  policy: StartupPolicy
): Promise<Prepared> {
  const created = {
    path: `/remote/${label}`,
    head: 'def',
    branch: `refs/heads/${label}`,
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
      setupAgentStartupPolicy: policy,
      scripts: { setup: '', archive: '' }
    }
  }
  const hostId = getRepoExecutionHostId(remoteRepo)
  const persisted = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession(), hostId)
  const metaById: Record<string, ReturnType<typeof makeWorktreeMeta>> = {}
  const remoteStore = {
    ...persisted.runtimeStore,
    getRepos: () => [remoteRepo],
    getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
    setWorktreeMeta: (worktreeId: string, meta: Partial<ReturnType<typeof makeWorktreeMeta>>) => {
      metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
      return metaById[worktreeId]
    }
  }
  const git = {
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
        return { stdout: `/remote/repo/.git/worktrees/${label}/orca/setup-runner.sh\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        throw new Error('missing local branch')
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    }),
    addWorktree: vi.fn().mockResolvedValue(undefined),
    listWorktrees: vi.fn().mockResolvedValue([created])
  }
  const filesystem = {
    readFile: vi.fn().mockResolvedValue({ isBinary: false, content: 'hooks:\n' }),
    createDir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined)
  }
  vi.mocked(getEffectiveHooksFromConfig).mockReturnValue({
    scripts: { setup: 'pnpm worktree:setup' }
  })
  vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SSH worktree creation and setup-runner resolution call only exec, addWorktree and listWorktrees on this git fake; any other member would throw, not read a wrong value.
  registerSshGitProvider('ssh-1', git as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hook discovery and runner-script writes call only readFile, createDir and writeFile on this filesystem fake.
  registerSshFilesystemProvider('ssh-1', filesystem as never)
  sshConnections.push('ssh-1')
  getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
  const directory = storageDirectory()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime store is the harness's real persisted store with only repo and worktree-meta accessors overridden for the remote repo.
  const installed = installRuntime(label, remoteStore as never, directory)
  const result = await installed.runtime.createManagedWorktree({
    repoSelector: TEST_REPO_ID,
    name: label,
    setupDecision: 'run',
    startup: { command: 'claude' },
    observeSetupCompletion: true,
    awaitTerminalProvisioning: true
  })
  return {
    ...installed,
    directory,
    persisted,
    ...(await bindCreatedPreparation(installed, label, result.worktree.id))
  }
}

export type Prepared = InstalledRuntime & {
  directory: string
  persisted: ReturnType<typeof makeRuntimeStoreWithWorkspaceSession>
} & Awaited<ReturnType<typeof bindCreatedPreparation>>

function terminalTab(
  worktreeId: string,
  id: string,
  ptyId: string,
  title: string,
  sortOrder: number
): SessionTab {
  return { id, ptyId, worktreeId, title, customTitle: null, color: null, sortOrder, createdAt: 1 }
}

function tabLayout(leaves: [leafId: string, ptyId: string][]): SessionLayout {
  const [first, second] = leaves
  return {
    root: second
      ? {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: first![0] },
          second: { type: 'leaf', leafId: second[0] }
        }
      : { type: 'leaf', leafId: first![0] },
    activeLeafId: first![0],
    expandedLeafId: null,
    ptyIdsByLeafId: Object.fromEntries(leaves)
  }
}

/**
 * Persisted surfaces the renderer would restore. `tabs`: Setup and the agent each own a tab.
 * `split`: Setup and the agent share one tab. Siblings are continuing work in their own tabs.
 */
export function persistSession(
  p: Prepared,
  layout: 'tabs' | 'split',
  siblings: string[] = []
): WorkspaceSessionState {
  const { setup, agent, worktreeId } = p
  const tabs: SessionTab[] = [terminalTab(worktreeId, setup.tabId, setup.ptyId, 'Setup', 0)]
  const layouts: Record<string, SessionLayout> = {}
  if (layout === 'split') {
    layouts[setup.tabId] = tabLayout([
      [setup.leafId, setup.ptyId],
      [agent.leafId, agent.ptyId]
    ])
  } else {
    tabs.push(terminalTab(worktreeId, agent.tabId, agent.ptyId, 'OMP', 1))
    layouts[setup.tabId] = tabLayout([[setup.leafId, setup.ptyId]])
    layouts[agent.tabId] = tabLayout([[agent.leafId, agent.ptyId]])
  }
  siblings.forEach((ptyId, index) => {
    tabs.push(terminalTab(worktreeId, `tab-${ptyId}`, ptyId, 'Shell', 2 + index))
    layouts[`tab-${ptyId}`] = tabLayout([[`leaf-${ptyId}`, ptyId]])
  })
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [worktreeId]: tabs },
    terminalLayoutsByTabId: layouts
  }
  p.persisted.setSession(session)
  return session
}

/** Continuing work the operator started beside the preparation: a server, a watcher, a shell. */
export async function openSiblings(
  p: Prepared
): Promise<{ server: string; watcher: string; shell: string }> {
  const before = p.spawned.extras.length
  await p.runtime.createTerminal(`id:${p.worktreeId}`, { command: 'pnpm dev', title: 'Server' })
  await p.runtime.createTerminal(`id:${p.worktreeId}`, {
    command: 'pnpm test --watch',
    title: 'Watcher'
  })
  await p.runtime.createTerminal(`id:${p.worktreeId}`, {})
  const [server, watcher, shell] = p.spawned.extras.slice(before)
  if (!server || !watcher || !shell) {
    throw new Error('sibling terminals did not spawn')
  }
  return { server, watcher, shell }
}

export function setupOutput(p: Prepared, data: string): void {
  p.runtime.onPtyData(p.setup.ptyId, data, Date.now())
}

export function completeRunner(p: Prepared, status = 0): void {
  setupOutput(p, `${SETUP_COMPLETION_PREFIX}${p.token}:${status}\r\n$ `)
}

/** The status extension's root readiness fields, as the hook transport delivers them. */
export function readinessReceipt(
  p: Prepared,
  options: { authenticated?: boolean; hookEventName?: string } = {}
): void {
  observeAuthenticatedHookBody(
    {
      paneKey: p.spawned.agentEnv.ORCA_PANE_KEY,
      launchToken: p.spawned.agentEnv.ORCA_AGENT_LAUNCH_TOKEN,
      payload: {
        hook_event_name: options.hookEventName ?? 'session_start',
        root_session_ready: true,
        root_session_id: `root-${p.preparationId}`,
        status_owner_module: STATUS_OWNER_MODULE
      }
    },
    options.authenticated ?? true
  )
}

export async function awaitRetirement(p: Prepared): Promise<void> {
  // The renderer mirror is the last step of removal, after the durable leaf retirement.
  await vi.waitFor(() => expect(p.retireTerminalSurface).toHaveBeenCalled(), {
    timeout: RETIREMENT_TIMEOUT_MS
  })
  await expect(p.runtime.evaluatePreparationRetirement(p.preparationId)).resolves.toEqual({
    outcome: 'retired'
  })
}

export function archives(runtime: InstanceType<typeof OrcaRuntimeService>, p: Prepared) {
  const store = runtime.getPreparationOutputStore()
  if (!store) {
    throw new Error('preparation storage is not configured')
  }
  const listed = store.list({
    host: p.record.worktree.executionHostId,
    worktreeKey: p.record.worktree.key
  })
  return listed.map((archive) => ({ ...archive, text: readArchiveText(store, archive.archiveId) }))
}

export function expectOnlySetupStopped(p: Prepared): void {
  expect(p.retireIdle).toHaveBeenCalledTimes(1)
  expect(p.retireIdle).toHaveBeenCalledWith(
    p.setup.ptyId,
    expect.objectContaining({ expectedIncarnationId: p.setup.incarnationId })
  )
  expect(p.kill).not.toHaveBeenCalled()
  // A tab-id close would take every pane of that tab with it; only the exact leaf is mirrored.
  expect(p.closeTerminal).not.toHaveBeenCalled()
  expect(p.retireTerminalSurface).toHaveBeenCalledWith({
    tabId: p.setup.tabId,
    leafId: p.setup.leafId,
    ptyId: p.setup.ptyId
  })
}

export async function expectRetained(p: Prepared, before: WorkspaceSessionState): Promise<void> {
  expect(p.retireIdle).not.toHaveBeenCalled()
  expect(p.kill).not.toHaveBeenCalled()
  expect(p.retireTerminalSurface).not.toHaveBeenCalled()
  expect(p.persisted.getSession()).toEqual(before)
  expect(p.runtime.mayEnqueuePreparationSetup(p.preparationId)).toBe(true)
  // AX reads this inventory as-is: a refused cleanup is still an occupied terminal.
  const { terminals } = await p.runtime.listTerminals()
  expect(terminals).toEqual(
    expect.arrayContaining([expect.objectContaining({ ptyId: p.setup.ptyId })])
  )
}
