import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite, type PtyIpcSuiteFixtures } from './pty-ipc-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
import { createWorktreeIdentity } from '../../shared/worktree/identity'
import type {
  PreparationPaneBinding,
  PreparationSpawnIntake
} from '../../shared/preparation-contracts'
import {
  PreparationRecordStore,
  type PreparationPaneReservation
} from '../runtime/preparation/preparation-record-store'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

const worktreeId = 'repo-1::/tmp/prep'
const cwd = '/tmp/prep'
const tabId = 'tab-prep'
const leafId = '34343434-3434-4434-8434-343434343434'
const paneKey = makePaneKey(tabId, leafId)

function registerWithFakes(
  mainWindow: PtyIpcSuiteFixtures['mainWindow'],
  runtime: unknown,
  store: unknown
): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spawn reads only the window, runtime and store members these fakes define.
  const args = [
    mainWindow,
    runtime,
    undefined,
    undefined,
    undefined,
    store
  ] as unknown as Parameters<typeof registerPtyHandlers>
  registerPtyHandlers(...args)
}

function installPreparationHarness(options: { spawnFails?: boolean } = {}) {
  const providerSpawn = vi.fn(async () => {
    if (options.spawnFails) {
      throw new Error('spawn boom')
    }
    return { id: 'pty-prep', incarnationId: 'inc-prep' }
  })
  const provider = {
    spawn: providerSpawn,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    shutdown: vi.fn(),
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(),
    getForegroundProcess: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listProcesses: vi.fn(async () => []),
    attach: vi.fn(),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fresh spawn calls only the provider members this fake defines.
  setLocalPtyProvider(provider as unknown as Parameters<typeof setLocalPtyProvider>[0])
  let session = { tabsByWorktree: {}, terminalLayoutsByTabId: {} }
  const store = {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn((next) => {
      session = next
    }),
    flushOrThrow: vi.fn(),
    runDurableMutation: vi.fn(async <T>(mutate: () => { value: T }) => mutate().value),
    persistPtyBinding: vi.fn(),
    getFolderWorkspace: vi.fn(() => undefined),
    getFolderWorkspaces: vi.fn(() => []),
    getProjectGroups: vi.fn(() => []),
    getRepos: vi.fn(() => [])
  }
  // Why a real store: the assertions read the registration the runtime would hold, not call echoes.
  const records = new PreparationRecordStore()
  const registration = records.register(
    createWorktreeIdentity({ worktreeId, executionHostId: 'local', instanceId: 'instance-prep' }),
    worktreeId
  )
  // Durable tombstones the managing runtime would answer from its lifecycle store.
  const retiredPreparations = new Set<string>()
  const runtime = {
    setPtyController: vi.fn(),
    resolveTerminalPane: vi.fn(() => {
      throw new Error('terminal_not_found')
    }),
    markPtyStopRequested: vi.fn(),
    createPreAllocatedTerminalHandle: vi.fn(() => 'term-prep'),
    preAllocateHandleForPty: vi.fn(() => 'term-prep'),
    registerPreAllocatedHandleForPty: vi.fn(),
    beginPtyRegistration: vi.fn(),
    cancelPendingPtyRegistration: vi.fn(),
    assertPtyRegistrationAllowed: vi.fn(),
    registerPty: vi.fn(),
    noteTerminalSpawnCommand: vi.fn(),
    seedHeadlessTerminal: vi.fn(),
    onPtySpawned: vi.fn(),
    onPtyExit: vi.fn(),
    onPtyData: vi.fn(),
    mayEnqueuePreparationSetup: (preparationId: string) => !retiredPreparations.has(preparationId),
    reservePreparationPane: vi.fn(
      (intake: PreparationSpawnIntake, locator: string, reservation: PreparationPaneReservation) =>
        records.reserve(intake, locator, reservation)
    ),
    bindPreparationPane: vi.fn(
      (intake: PreparationSpawnIntake, locator: string, binding: PreparationPaneBinding) =>
        records.bind(intake, locator, binding)
    ),
    releasePreparationPane: vi.fn((intake: PreparationSpawnIntake, handle: string) =>
      records.releaseReservation(intake, handle)
    )
  }
  return { providerSpawn, store, runtime, records, registration, retiredPreparations }
}

function setupSpawnArgs(preparation: unknown) {
  return {
    cols: 80,
    rows: 24,
    cwd,
    command: 'bash /tmp/prep/.git/orca/setup-runner.sh',
    worktreeId,
    tabId,
    leafId,
    env: { ORCA_PANE_KEY: paneKey, ORCA_TAB_ID: tabId, ORCA_WORKTREE_ID: worktreeId },
    preparation
  }
}

describe('pty:spawn preparation binding', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it('arms the role before the provider spawns and binds the acknowledged incarnation', async () => {
    const { providerSpawn, store, runtime, records, registration } = installPreparationHarness()
    registerWithFakes(mainWindow, runtime, store)

    await handlers.get('pty:spawn')!(
      null,
      setupSpawnArgs({ preparationId: registration.preparationId, role: 'preparation' })
    )

    expect(runtime.reservePreparationPane.mock.invocationCallOrder[0]).toBeLessThan(
      providerSpawn.mock.invocationCallOrder[0]!
    )
    expect(records.list()).toEqual([
      expect.objectContaining({
        preparationId: registration.preparationId,
        preparation: {
          handle: 'term-prep',
          ptyId: 'pty-prep',
          incarnationId: 'inc-prep',
          tabId,
          leafId,
          paneKey
        },
        agent: null
      })
    ])
  })

  it('leaves the registration unbound when the spawn is never acknowledged', async () => {
    const { store, runtime, records, registration } = installPreparationHarness({
      spawnFails: true
    })
    registerWithFakes(mainWindow, runtime, store)

    await expect(
      handlers.get('pty:spawn')!(
        null,
        setupSpawnArgs({ preparationId: registration.preparationId, role: 'preparation' })
      )
    ).rejects.toThrow('spawn boom')

    expect(records.list()[0]).toMatchObject({ preparation: null, agent: null })
  })

  it.each([
    ['an unregistered id', { preparationId: 'forged', role: 'preparation' }],
    ['an unknown role', { preparationId: 'REGISTERED', role: 'setup' }],
    ['no intake', undefined]
  ])('spawns unowned for %s', async (_label, preparation) => {
    const { providerSpawn, store, runtime, records, registration } = installPreparationHarness()
    registerWithFakes(mainWindow, runtime, store)
    const intake =
      preparation?.preparationId === 'REGISTERED'
        ? { ...preparation, preparationId: registration.preparationId }
        : preparation

    await expect(handlers.get('pty:spawn')!(null, setupSpawnArgs(intake))).resolves.toMatchObject({
      id: 'pty-prep'
    })

    expect(providerSpawn).toHaveBeenCalledOnce()
    expect(records.list()[0]).toMatchObject({ preparation: null, agent: null })
  })

  it('refuses to rerun a retired preparation from a deferred renderer spawn', async () => {
    const { providerSpawn, store, runtime, records, registration, retiredPreparations } =
      installPreparationHarness()
    retiredPreparations.add(registration.preparationId)
    registerWithFakes(mainWindow, runtime, store)

    await expect(
      handlers.get('pty:spawn')!(
        null,
        setupSpawnArgs({ preparationId: registration.preparationId, role: 'preparation' })
      )
    ).rejects.toThrow('preparation_retired')

    expect(providerSpawn).not.toHaveBeenCalled()
    expect(records.list()[0]).toMatchObject({ preparation: null, agent: null })
  })
})
