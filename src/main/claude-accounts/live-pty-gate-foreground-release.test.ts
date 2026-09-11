import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'
import { releaseClaudeLivePtyOnNonClaudeForeground } from './live-pty-gate-foreground-release'
import {
  attachClaudeLivePtyPersistence,
  hasLiveClaudePtys,
  markClaudePtyExited,
  markClaudePtySpawned,
  onLiveClaudePtysDrained
} from './live-pty-gate'

vi.mock('../rate-limits/claude-auth-diagnostics-log', () => ({
  logClaudeAuthDiagnostic: vi.fn()
}))

function liveInspection(processName: string | null): TerminalProcessInspection {
  return {
    foregroundProcess: processName,
    hasChildProcesses: processName !== null,
    foregroundProcessEvidence: {
      verdict: 'live',
      processName,
      fence: {
        platform: 'posix',
        shellPid: 4242,
        shellStartTime: '1',
        tty: '/dev/ttys001',
        foregroundPgid: 4242
      },
      authorityGeneration: 'gen-1',
      observationEpoch: 1,
      capturedAgeMs: 0,
      ptyId: 'pty-claude',
      ptyIncarnationId: 'incarnation-1'
    }
  }
}

const UNVERIFIABLE_INSPECTION: TerminalProcessInspection = {
  foregroundProcess: null,
  hasChildProcesses: false,
  foregroundProcessEvidence: {
    verdict: 'unverifiable',
    reason: 'process_table_unreadable',
    authorityGeneration: 'gen-1',
    observationEpoch: 1,
    capturedAgeMs: 0,
    ptyId: 'pty-claude',
    ptyIncarnationId: 'incarnation-1'
  }
}

// A cheap steady-state tick answers with the name only and pays for no evidence.
const CHEAP_TICK_INSPECTION: TerminalProcessInspection = {
  foregroundProcess: 'zsh',
  hasChildProcesses: true
}

describe('releasing the Claude live-PTY gate from a foreground observation', () => {
  afterEach(() => {
    markClaudePtyExited('pty-claude')
    // Why: an id the gate no longer holds also drops its "saw Claude here" mark,
    // so this call leaves no cross-test memory of the launch race.
    releaseClaudeLivePtyOnNonClaudeForeground('pty-claude', UNVERIFIABLE_INSPECTION, 'steady-state')
    attachClaudeLivePtyPersistence(null)
  })

  it('releases a pane whose Claude exited back to its shell, draining once', () => {
    const removeClaudeLivePtySessionId = vi.fn()
    attachClaudeLivePtyPersistence({
      addClaudeLivePtySessionId: vi.fn(),
      removeClaudeLivePtySessionId
    })
    const drained = vi.fn()
    const unsubscribe = onLiveClaudePtysDrained(drained)
    try {
      markClaudePtySpawned('pty-claude', { route: 'account-dir', accountId: 'account-1' })

      expect(
        releaseClaudeLivePtyOnNonClaudeForeground(
          'pty-claude',
          liveInspection('claude'),
          'steady-state'
        )
      ).toBe(false)
      expect(hasLiveClaudePtys()).toBe(true)

      expect(
        releaseClaudeLivePtyOnNonClaudeForeground(
          'pty-claude',
          liveInspection('zsh'),
          'steady-state'
        )
      ).toBe(true)
      expect(hasLiveClaudePtys()).toBe(false)
      expect(drained).toHaveBeenCalledTimes(1)
      // The persisted binding row goes with the id — leaving it would re-attribute a recycled session.
      expect(removeClaudeLivePtySessionId).toHaveBeenCalledExactlyOnceWith('pty-claude')

      // A second observation of the same shell must not re-fire anything.
      expect(
        releaseClaudeLivePtyOnNonClaudeForeground(
          'pty-claude',
          liveInspection('zsh'),
          'steady-state'
        )
      ).toBe(false)
      expect(drained).toHaveBeenCalledTimes(1)
      expect(removeClaudeLivePtySessionId).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it('releases a pane that now runs another agent', () => {
    markClaudePtySpawned('pty-claude', { route: 'shared-dir' })

    expect(
      releaseClaudeLivePtyOnNonClaudeForeground('pty-claude', liveInspection('omp'), 'steady-state')
    ).toBe(true)
    expect(hasLiveClaudePtys()).toBe(false)
  })

  it('waits out a launch it has not seen Claude in yet', () => {
    markClaudePtySpawned('pty-claude', { route: 'account-dir', accountId: 'account-1' })

    // The pane still shows the shell between spawn and exec; releasing here
    // would rotate the refresh token out from under the Claude about to start.
    expect(
      releaseClaudeLivePtyOnNonClaudeForeground('pty-claude', liveInspection(null), 'steady-state')
    ).toBe(false)
    expect(hasLiveClaudePtys()).toBe(true)
  })

  it('trusts an empty pane restored from a previous process', () => {
    markClaudePtySpawned('pty-claude', { route: 'shared-dir' })

    expect(
      releaseClaudeLivePtyOnNonClaudeForeground(
        'pty-claude',
        liveInspection(null),
        'startup-reconcile'
      )
    ).toBe(true)
    expect(hasLiveClaudePtys()).toBe(false)
  })

  it.each<[string, TerminalProcessInspection]>([
    ['claude still owns the foreground', liveInspection('claude')],
    ['the host could not read its process table', UNVERIFIABLE_INSPECTION],
    ['the answer carries no evidence', CHEAP_TICK_INSPECTION],
    // A bare interpreter may BE the Claude CLI, so it is not proof of anything.
    ['the foreground is an unrecognized command', liveInspection('node')]
  ])('keeps the gate when %s', (_label, inspection) => {
    markClaudePtySpawned('pty-claude', { route: 'account-dir', accountId: 'account-1' })

    expect(
      releaseClaudeLivePtyOnNonClaudeForeground('pty-claude', inspection, 'startup-reconcile')
    ).toBe(false)
    expect(hasLiveClaudePtys()).toBe(true)
  })

  it('never re-adds an id the gate does not hold', () => {
    expect(
      releaseClaudeLivePtyOnNonClaudeForeground(
        'pty-claude',
        liveInspection('zsh'),
        'startup-reconcile'
      )
    ).toBe(false)
    expect(hasLiveClaudePtys()).toBe(false)
  })
})
