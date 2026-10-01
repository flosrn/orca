// Idle retirement for PTYs the Electron process owns directly: retireIdle stops only the exact incarnation it
// still holds, when no input landed while it inspected and the capture shows a bare shell.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from './macos-tcc-login-shell'
import type * as SnapshotReader from '../../shared/process-table-snapshot-reader'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

const {
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  spawnMock,
  prepareMacosTccLoginShellMock,
  resolveAgentForegroundProcessMock,
  readWindowsPtyJobProcessIdsMock,
  killWithDescendantSweepMock,
  isWslAvailableAsyncMock,
  wslUncDirectoryExistsMock,
  createShellPromptReadinessProbeMock,
  readSnapshot
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  prepareMacosTccLoginShellMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn(),
  readWindowsPtyJobProcessIdsMock: vi.fn(),
  killWithDescendantSweepMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  wslUncDirectoryExistsMock: vi.fn(),
  createShellPromptReadinessProbeMock: vi.fn(),
  readSnapshot: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/orca-user-data')
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('./macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('./windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
}))

vi.mock('../wsl', () => ({
  parseWslPath: () => null,
  toLinuxPath: (path: string) => path,
  toWindowsWslPath: (path: string) => path,
  getDefaultWslDistro: () => 'Ubuntu',
  isWslAvailableAsync: () => isWslAvailableAsyncMock(),
  wslUncDirectoryExists: (...args: unknown[]) => wslUncDirectoryExistsMock(...args)
}))

vi.mock('../shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotReader>()),
  getStrictProcessTableSnapshotStartedAfterRequest: readSnapshot
}))

import { LocalPtyProvider } from './local-pty-provider'
import {
  applyLocalPtyProviderMockDefaults,
  createLocalPtyMockProcess,
  installLocalPtyProviderEnvSandbox,
  type LocalPtyMockProcess
} from './local-pty-provider-test-harness'

type Capture = { rows: ProcessTableRow[]; capturedAgeMs: number }

/** createLocalPtyMockProcess's pid. */
const SHELL = 12345
const INIT: ProcessTableRow = { pid: 1, ppid: 0, pgid: 1, tpgid: -1, stat: 'Ss', command: 'init' }
const IDLE_SHELL: ProcessTableRow = {
  pid: SHELL,
  ppid: 1,
  pgid: SHELL,
  tpgid: SHELL,
  stat: 'Ss+',
  command: 'zsh -i'
}
const IDLE: Capture = { rows: [INIT, IDLE_SHELL], capturedAgeMs: 0 }
/** A preparation step's `&` background job still running in the shell's own process group. */
const BACKGROUND_JOB: Capture = {
  rows: [
    INIT,
    IDLE_SHELL,
    { pid: 12_400, ppid: SHELL, pgid: SHELL, tpgid: SHELL, stat: 'S', command: 'pnpm dev' }
  ],
  capturedAgeMs: 0
}

describe('LocalPtyProvider.retireIdle', () => {
  let provider: LocalPtyProvider
  let mockProc: LocalPtyMockProcess
  let exitCb: ((info: { exitCode: number }) => void) | undefined
  let killSpy: LocalPtyMockProcess['kill']

  installLocalPtyProviderEnvSandbox()

  async function spawnPty(): Promise<{ id: string; incarnationId: string }> {
    const { id, incarnationId } = await provider.spawn({ cols: 80, rows: 24 })
    if (!incarnationId) {
      throw new Error('local spawn reported no incarnation')
    }
    readSnapshot.mockClear()
    return { id, incarnationId }
  }

  beforeEach(() => {
    applyLocalPtyProviderMockDefaults({
      existsSyncMock,
      statSyncMock,
      accessSyncMock,
      mkdirSyncMock,
      writeFileSyncMock,
      prepareMacosTccLoginShellMock,
      resolveAgentForegroundProcessMock,
      readWindowsPtyJobProcessIdsMock,
      killWithDescendantSweepMock,
      isWslAvailableAsyncMock,
      wslUncDirectoryExistsMock,
      createShellPromptReadinessProbeMock
    })
    readSnapshot.mockReset()
    readSnapshot.mockResolvedValue(IDLE)
    exitCb = undefined
    mockProc = createLocalPtyMockProcess({
      get: () => exitCb,
      set: (cb) => {
        exitCb = cb
      }
    })
    // Captured before a stop neutralizes the process's kill.
    killSpy = mockProc.kill
    spawnMock.mockReturnValue(mockProc)
    provider = new LocalPtyProvider()
  })

  it('stops the exact idle shell', async () => {
    const { id, incarnationId } = await spawnPty()

    await expect(
      provider.retireIdle(id, { expectedIncarnationId: incarnationId })
    ).resolves.toEqual({ outcome: 'stopped' })
    expect(killSpy).toHaveBeenCalled()
    expect(provider.hasPty(id)).toBe(false)
  })

  it('retains a shell still running a background job', async () => {
    readSnapshot.mockResolvedValue(BACKGROUND_JOB)
    const { id, incarnationId } = await spawnPty()

    await expect(
      provider.retireIdle(id, { expectedIncarnationId: incarnationId })
    ).resolves.toEqual({ outcome: 'retained', reason: 'not_idle' })
    expect(killSpy).not.toHaveBeenCalled()
    expect(provider.hasPty(id)).toBe(true)
  })

  it('never stops a PTY under an incarnation it does not hold', async () => {
    const { id } = await spawnPty()

    await expect(
      provider.retireIdle(id, { expectedIncarnationId: 'recorded-before-replacement' })
    ).resolves.toEqual({ outcome: 'retained', reason: 'incarnation_mismatch' })
    expect(killSpy).not.toHaveBeenCalled()
    expect(provider.hasPty(id)).toBe(true)
  })

  it('retains, and still delivers, input typed while it inspects', async () => {
    const { id, incarnationId } = await spawnPty()
    const inspection = Promise.withResolvers<Capture>()
    readSnapshot.mockReturnValue(inspection.promise)

    const retirement = provider.retireIdle(id, { expectedIncarnationId: incarnationId })
    await vi.waitFor(() => expect(readSnapshot).toHaveBeenCalled())
    provider.write(id, 'npm run dev\r')
    inspection.resolve(IDLE)

    await expect(retirement).resolves.toEqual({
      outcome: 'retained',
      reason: 'input_during_inspection'
    })
    expect(mockProc.write).toHaveBeenCalledWith('npm run dev\r')
    expect(killSpy).not.toHaveBeenCalled()
    expect(provider.hasPty(id)).toBe(true)
  })

  it('retains on an unreadable process table', async () => {
    readSnapshot.mockRejectedValue(new Error('ps failed'))
    const { id, incarnationId } = await spawnPty()

    await expect(
      provider.retireIdle(id, { expectedIncarnationId: incarnationId })
    ).resolves.toEqual({ outcome: 'retained', reason: 'unverifiable' })
    expect(killSpy).not.toHaveBeenCalled()
  })

  it('retains on Windows, where no foreground primitive proves the ConPTY job idle', async () => {
    const { id, incarnationId } = await spawnPty()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    await expect(
      provider.retireIdle(id, { expectedIncarnationId: incarnationId })
    ).resolves.toEqual({ outcome: 'retained', reason: 'unverifiable' })
    expect(readSnapshot).not.toHaveBeenCalled()
    expect(killSpy).not.toHaveBeenCalled()
  })
})
