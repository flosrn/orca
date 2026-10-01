import './mock-descendant-sweep'
// Idle retirement at the execution host: automatic preparation cleanup may stop a relay PTY only when this
// host, in one bounded step, still holds the exact incarnation the caller recorded, attests the
// caller as its creator, and observes a bare shell with nothing that the stop would reach.
// Anything short of that retains the pane; `pty.shutdown` remains the unconditional teardown.
import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  endPtyHandlerTest,
  type MockDispatcher
} from './pty-handler-test-harness'
import * as processTableSnapshotReader from '../shared/process-table-snapshot-reader'
import type { ProcessTableRow } from '../shared/process-table-snapshot'
import { RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS } from '../shared/ssh-relay-pty-ownership-proof'
import { isRecord } from '../shared/agent-status-child-work-value-guards'

const PANE_KEY = 'tab-setup:33333333-3333-4333-8333-333333333333'
const SHELL = process.pid

/** `ps -axo pid=,ppid=,pgid=,tpgid=,stat=,command=` shapes, rooted at the mocked PTY pid. */
const INIT: ProcessTableRow = { pid: 1, ppid: 0, pgid: 1, tpgid: -1, stat: 'Ss', command: 'init' }
const IDLE_SHELL: ProcessTableRow = {
  pid: SHELL,
  ppid: 1,
  pgid: SHELL,
  tpgid: SHELL,
  stat: 'Ss+',
  command: 'bash -i'
}
const TABLES: Record<string, ProcessTableRow[]> = {
  idle: [INIT, IDLE_SHELL],
  /** `pnpm dev &`: own process group on the pane's tty. */
  backgroundWatcher: [
    INIT,
    IDLE_SHELL,
    { pid: 990_101, ppid: SHELL, pgid: 990_101, tpgid: SHELL, stat: 'S', command: 'pnpm dev' }
  ],
  /** `set +m; pnpm build &`: shares the shell's pgid, so the tty shows one group. */
  jobControlOffBuild: [
    INIT,
    IDLE_SHELL,
    { pid: 990_102, ppid: SHELL, pgid: SHELL, tpgid: SHELL, stat: 'S+', command: 'pnpm build' }
  ],
  /** `setsid pnpm dev &`: left the tty and the shell's group, but is still the shell's child and
   *  therefore inside the descendant sweep an immediate stop performs. */
  detachedChildService: [
    INIT,
    IDLE_SHELL,
    { pid: 990_103, ppid: SHELL, pgid: 990_103, tpgid: -1, stat: 'Ss', command: 'pnpm dev' }
  ]
}

describe('PtyHandler retires only a proven-idle PTY it attests the caller created', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let snapshot: MockInstance<
    typeof processTableSnapshotReader.getStrictProcessTableSnapshotStartedAfterRequest
  >

  type Spawned = { id: string; incarnationId: string; exit: (code: number) => void }

  async function spawnFrom(clientId: number): Promise<Spawned> {
    const onExit = vi.fn<(listener: (event: { exitCode: number }) => void) => void>()
    const instance = { ...mockPtyInstance, onData: vi.fn(), onExit }
    mockPtySpawn.mockReturnValue(instance)
    const result = await dispatcher.callRequest(
      'pty.spawn',
      { env: { ORCA_PANE_KEY: PANE_KEY } },
      { clientId, isStale: () => false }
    )
    if (
      !isRecord(result) ||
      typeof result.id !== 'string' ||
      typeof result.incarnationId !== 'string'
    ) {
      throw new Error(`pty.spawn returned no incarnation: ${JSON.stringify(result)}`)
    }
    return {
      id: result.id,
      incarnationId: result.incarnationId,
      exit: (exitCode) => {
        for (const [listener] of onExit.mock.calls) {
          listener({ exitCode })
        }
      }
    }
  }

  function retire(
    pty: Pick<Spawned, 'id' | 'incarnationId'>,
    clientId: number,
    overrides: Record<string, unknown> = {}
  ): Promise<unknown> {
    return dispatcher.callRequest(
      'pty.retireIdle',
      {
        id: pty.id,
        expectedIncarnationId: pty.incarnationId,
        expectedOwnerClientInstanceId: 'client-A',
        ...overrides
      },
      { clientId, isStale: () => false }
    )
  }

  async function listedPtys(): Promise<Record<string, unknown>[]> {
    const entries = await dispatcher.callRequest('pty.listProcesses', {})
    if (!Array.isArray(entries)) {
      throw new Error(`pty.listProcesses returned no list: ${JSON.stringify(entries)}`)
    }
    return entries.filter(isRecord)
  }

  async function isStillHeld(id: string): Promise<boolean> {
    return (await listedPtys()).some((entry) => entry.id === id)
  }

  function useTable(rows: ProcessTableRow[], capturedAgeMs = 0): void {
    snapshot.mockResolvedValue({ rows, capturedAgeMs })
  }

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    handler.setConsumerIdentityResolver((clientId) =>
      clientId === 7 ? 'client-A' : clientId === 8 ? 'client-B' : null
    )
    // Inventory reads stay on the shared capture; only the stop's authorizing capture is post-fence.
    vi.spyOn(processTableSnapshotReader, 'getStrictProcessTableSnapshotWithAge').mockResolvedValue({
      rows: TABLES.idle,
      capturedAgeMs: 0
    })
    snapshot = vi.spyOn(
      processTableSnapshotReader,
      'getStrictProcessTableSnapshotStartedAfterRequest'
    )
    useTable(TABLES.idle)
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('stops the exact idle shell for its attested creator and reports it after physical exit', async () => {
    const pty = await spawnFrom(7)

    const retirement = retire(pty, 7)
    await vi.waitFor(() => expect(mockPtyInstance.kill).toHaveBeenCalled())
    pty.exit(137)

    await expect(retirement).resolves.toEqual({ outcome: 'stopped' })
    expect(await isStillHeld(pty.id)).toBe(false)
  })

  it.each([
    ['a background watcher in its own process group', 'backgroundWatcher'],
    ['a job-control-off build sharing the shell group', 'jobControlOffBuild'],
    ['a detached service that is still the shell child', 'detachedChildService']
  ])('retains a pane running %s', async (_label, table) => {
    useTable(TABLES[table])
    const pty = await spawnFrom(7)

    await expect(retire(pty, 7)).resolves.toEqual({ outcome: 'retained', reason: 'not_idle' })
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
    expect(await isStillHeld(pty.id)).toBe(true)
  })

  it('never stops a replacement incarnation under a recorded one', async () => {
    const pty = await spawnFrom(7)

    await expect(
      retire({ id: pty.id, incarnationId: 'incarnation-recorded-before-replacement' }, 7)
    ).resolves.toEqual({ outcome: 'retained', reason: 'incarnation_mismatch' })
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
    expect(await isStillHeld(pty.id)).toBe(true)
  })

  it.each([
    ['another client asserts the creator identity', 8, {}],
    ['the connection holds no grant', 99, {}],
    ['the caller names no creator at all', 7, { expectedOwnerClientInstanceId: undefined }]
  ])('retains when %s', async (_label, clientId, overrides) => {
    const pty = await spawnFrom(7)

    await expect(retire(pty, clientId, overrides)).resolves.toEqual({
      outcome: 'retained',
      reason: 'owner_unattested'
    })
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
    expect(await isStillHeld(pty.id)).toBe(true)
  })

  it('retains a revived PTY this host never attested', async () => {
    const revivedId = 'pty-revived-preparation'
    await dispatcher.callRequest(
      'pty.revive',
      {
        state: JSON.stringify([
          { id: revivedId, pid: SHELL, cwd: process.cwd(), paneKey: PANE_KEY, cols: 80, rows: 24 }
        ])
      },
      { clientId: 7, isStale: () => false }
    )
    const revived = (await listedPtys()).find((entry) => entry.id === revivedId)
    expect(revived, 'revive should have produced a live PTY entry').toBeDefined()
    const incarnationId =
      typeof revived?.incarnationId === 'string'
        ? revived.incarnationId
        : 'revived-incarnation-missing'

    await expect(retire({ id: revivedId, incarnationId }, 7)).resolves.toEqual({
      outcome: 'retained',
      reason: 'owner_unattested'
    })
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
  })

  it('retains, and still delivers, input that arrives while the host is inspecting', async () => {
    const pty = await spawnFrom(7)
    const inspection = Promise.withResolvers<{ rows: ProcessTableRow[]; capturedAgeMs: number }>()
    snapshot.mockClear()
    snapshot.mockReturnValue(inspection.promise)

    const retirement = retire(pty, 7)
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled())
    dispatcher.callNotification('pty.data', { id: pty.id, data: 'npm run dev\r' })
    inspection.resolve({ rows: TABLES.idle, capturedAgeMs: 0 })

    await expect(retirement).resolves.toEqual({
      outcome: 'retained',
      reason: 'input_during_inspection'
    })
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
    expect(mockPtyInstance.write).toHaveBeenCalledWith('npm run dev\r')
    expect(await isStillHeld(pty.id)).toBe(true)
  })

  it('retains on an observation too old to authorize a stop', async () => {
    useTable(TABLES.idle, RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS + 1)
    const pty = await spawnFrom(7)

    await expect(retire(pty, 7)).resolves.toEqual({ outcome: 'retained', reason: 'evidence_stale' })
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
  })

  it('retains on an unreadable process table rather than treating it as idle', async () => {
    snapshot.mockRejectedValue(new Error('ps failed'))
    const pty = await spawnFrom(7)

    await expect(retire(pty, 7)).resolves.toEqual({ outcome: 'retained', reason: 'unverifiable' })
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
  })

  it('retains on a Windows relay host, which has no foreground primitive to prove idleness', async () => {
    const pty = await spawnFrom(7)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    await expect(retire(pty, 7)).resolves.toEqual({ outcome: 'retained', reason: 'unverifiable' })
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
  })
})
