// Idle retirement at the local daemon: automatic preparation cleanup stops a session only when the daemon, in
// one step after its capture, still holds the exact incarnation, saw no input or output meanwhile,
// and observes a bare shell. Driven through a real DaemonServer and adapter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SnapshotReader from '../../shared/process-table-snapshot-reader'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'
import { IDLE_RETIREMENT_DAEMON_PROTOCOL_VERSION } from './daemon-protocol-version'

const { readSnapshot } = vi.hoisted(() => ({ readSnapshot: vi.fn() }))
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotReader>()),
  getStrictProcessTableSnapshotStartedAfterRequest: readSnapshot
}))

type Capture = { rows: ProcessTableRow[]; capturedAgeMs: number }

/** The harness subprocess's pid. */
const SHELL = 999_999_999

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
/** `setsid pnpm dev &`: off the tty and out of the shell group, but still inside the stop's reach. */
const DETACHED_SERVICE: Capture = {
  rows: [
    INIT,
    IDLE_SHELL,
    { pid: 990_201, ppid: SHELL, pgid: 990_201, tpgid: -1, stat: 'Ss', command: 'pnpm dev' }
  ],
  capturedAgeMs: 0
}
/**
 * macOS desktop spawns `/usr/bin/login -flpq <user> <shell>` for TCC attribution, so the session
 * root is the wrapper and the shell is its only child in its own group (captured from a real Orca
 * pane: login `Ss` in pgid 18111, `-/bin/zsh -l` `S+` in pgid 18115, tpgid 18115).
 */
const WRAPPED_ZSH = 990_300
function loginWrapped(foregroundPgid: number, ...jobs: ProcessTableRow[]): Capture {
  return {
    rows: [
      INIT,
      {
        pid: SHELL,
        ppid: 1,
        pgid: SHELL,
        tpgid: foregroundPgid,
        stat: 'Ss',
        command: '/usr/bin/login -flpq flo /bin/zsh -l'
      },
      {
        pid: WRAPPED_ZSH,
        ppid: SHELL,
        pgid: WRAPPED_ZSH,
        tpgid: foregroundPgid,
        stat: foregroundPgid === WRAPPED_ZSH ? 'S+' : 'S',
        command: '-/bin/zsh -l'
      },
      ...jobs
    ],
    capturedAgeMs: 0
  }
}
const LOGIN_IDLE = loginWrapped(WRAPPED_ZSH)
/** `sleep 300` in the foreground of the wrapped shell. */
const LOGIN_BUSY = loginWrapped(990_301, {
  pid: 990_301,
  ppid: WRAPPED_ZSH,
  pgid: 990_301,
  tpgid: 990_301,
  stat: 'S+',
  command: 'sleep 300'
})

// Windows retains every candidate (no foreground primitive); the POSIX proof is exercised here.
describe.skipIf(process.platform === 'win32')('daemon retireIdle', () => {
  let harness: DaemonAdapterHarness
  let subprocess: ReturnType<typeof createMockSubprocess>
  let rootIsLoginWrapper = false

  async function spawnSession(): Promise<{ id: string; incarnationId: string }> {
    const { id, incarnationId } = await harness.adapter.spawn({ cols: 80, rows: 24 })
    if (!incarnationId) {
      throw new Error('daemon spawn reported no incarnation')
    }
    readSnapshot.mockClear()
    return { id, incarnationId }
  }

  async function isListed(id: string): Promise<boolean> {
    return (await harness.adapter.listProcesses()).some((entry) => entry.id === id)
  }

  beforeEach(async () => {
    readSnapshot.mockReset()
    readSnapshot.mockResolvedValue(IDLE)
    rootIsLoginWrapper = false
    harness = await startDaemonAdapterHarness(() => {
      subprocess = Object.assign(
        createMockSubprocess(),
        rootIsLoginWrapper ? { rootIsLoginWrapper } : {}
      )
      return subprocess
    })
  })

  afterEach(async () => {
    harness.adapter.dispose()
    await harness.server.shutdown().catch(() => {})
  })

  it('stops the exact idle shell', async () => {
    const { id, incarnationId } = await spawnSession()

    await expect(
      harness.adapter.retireIdle(id, { expectedIncarnationId: incarnationId })
    ).resolves.toEqual({ outcome: 'stopped' })
    expect(subprocess.forceKill).toHaveBeenCalled()
    expect(await isListed(id)).toBe(false)
  })

  it('retains a shell whose detached child is still running', async () => {
    readSnapshot.mockResolvedValue(DETACHED_SERVICE)
    const { id, incarnationId } = await spawnSession()

    await expect(
      harness.adapter.retireIdle(id, { expectedIncarnationId: incarnationId })
    ).resolves.toEqual({ outcome: 'retained', reason: 'not_idle' })
    expect(subprocess.forceKill).not.toHaveBeenCalled()
    expect(subprocess.kill).not.toHaveBeenCalled()
    expect(await isListed(id)).toBe(true)
  })

  it('stops an idle shell the host spawned under the macOS login wrapper', async () => {
    rootIsLoginWrapper = true
    readSnapshot.mockResolvedValue(LOGIN_IDLE)
    const { id, incarnationId } = await spawnSession()

    await expect(
      harness.adapter.retireIdle(id, { expectedIncarnationId: incarnationId })
    ).resolves.toEqual({ outcome: 'stopped' })
    expect(subprocess.forceKill).toHaveBeenCalled()
  })

  it.each([
    ['the wrapped shell runs a foreground job', true, LOGIN_BUSY],
    ['the host did not spawn the root as a login wrapper', false, LOGIN_IDLE]
  ] as const)('retains when %s', async (_case, wrapped, capture) => {
    rootIsLoginWrapper = wrapped
    readSnapshot.mockResolvedValue(capture)
    const { id, incarnationId } = await spawnSession()

    await expect(
      harness.adapter.retireIdle(id, { expectedIncarnationId: incarnationId })
    ).resolves.toEqual({ outcome: 'retained', reason: 'not_idle' })
    expect(subprocess.forceKill).not.toHaveBeenCalled()
    expect(await isListed(id)).toBe(true)
  })

  it('never stops a session under an incarnation it does not hold', async () => {
    const { id } = await spawnSession()

    await expect(
      harness.adapter.retireIdle(id, { expectedIncarnationId: 'recorded-before-replacement' })
    ).resolves.toEqual({ outcome: 'retained', reason: 'incarnation_mismatch' })
    expect(subprocess.forceKill).not.toHaveBeenCalled()
    expect(await isListed(id)).toBe(true)
  })

  it('retains when the process table cannot be read', async () => {
    readSnapshot.mockRejectedValue(new Error('ps unavailable'))
    const { id, incarnationId } = await spawnSession()

    await expect(
      harness.adapter.retireIdle(id, { expectedIncarnationId: incarnationId })
    ).resolves.toEqual({ outcome: 'retained', reason: 'unverifiable' })
    expect(subprocess.forceKill).not.toHaveBeenCalled()
    expect(await isListed(id)).toBe(true)
  })

  it.each([
    [
      'input',
      'input_during_inspection',
      (id: string): (() => boolean) => {
        harness.adapter.write(id, 'npm run dev\r')
        // The daemon records input before it writes to the subprocess.
        return () => subprocess.write.mock.calls.length > 0
      }
    ],
    [
      'output',
      'output_during_inspection',
      (): (() => boolean) => {
        // Delivered synchronously into the daemon's session data path.
        subprocess._simulateData('watching for changes\r\n')
        return () => true
      }
    ]
  ] as const)('retains when %s lands while the daemon inspects', async (_kind, reason, arrive) => {
    const { id, incarnationId } = await spawnSession()
    const inspection = Promise.withResolvers<Capture>()
    readSnapshot.mockReturnValue(inspection.promise)

    const retirement = harness.adapter.retireIdle(id, { expectedIncarnationId: incarnationId })
    await waitFor(() => readSnapshot.mock.calls.length > 0)
    await waitFor(arrive(id))
    inspection.resolve(IDLE)

    await expect(retirement).resolves.toEqual({ outcome: 'retained', reason })
    expect(subprocess.forceKill).not.toHaveBeenCalled()
    expect(await isListed(id)).toBe(true)
  })
})

describe('daemon retireIdle against an older daemon', () => {
  it('retains without asking, because an older daemon only knows unconditional stops', async () => {
    const legacy = new DaemonPtyAdapter({
      socketPath: '/nonexistent/orca-idle-retirement-legacy.sock',
      tokenPath: '/nonexistent/orca-idle-retirement-legacy.token',
      protocolVersion: IDLE_RETIREMENT_DAEMON_PROTOCOL_VERSION - 1
    })

    await expect(
      legacy.retireIdle('any-session', { expectedIncarnationId: 'incarnation' })
    ).resolves.toEqual({ outcome: 'retained', reason: 'unsupported' })
    legacy.dispose()
  })
})
