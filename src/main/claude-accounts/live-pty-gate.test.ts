import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachClaudeLivePtyPersistence,
  beginClaudeAuthSwitch,
  claudeLivePtyBindingForPreparation,
  confirmSeededClaudeLivePtys,
  endClaudeAuthSwitch,
  hasLiveClaudePtys,
  hasLiveClaudePtysForAccount,
  hasLiveClaudeSessionsOnSharedSurface,
  isClaudeAuthSwitchInProgress,
  markClaudePtyExited,
  markClaudePtySpawned,
  markClaudeStructuredChildExited,
  markClaudeStructuredChildSpawned,
  onLiveClaudePtysDrained,
  seedLiveClaudePtysFromPersistence
} from './live-pty-gate'

describe('Claude live PTY gate', () => {
  afterEach(() => {
    markClaudePtyExited('live-claude-pty')
    markClaudePtyExited('seeded-pty-1')
    markClaudePtyExited('seeded-pty-2')
    markClaudePtyExited('pty-account-a')
    markClaudePtyExited('pty-account-b')
    markClaudePtyExited('pty-legacy')
    markClaudeStructuredChildExited('structured-a')
    confirmSeededClaudeLivePtys([])
    attachClaudeLivePtyPersistence(null)
    endClaudeAuthSwitch()
  })

  it('allows switching while Claude PTYs are live', () => {
    markClaudePtySpawned('live-claude-pty')

    beginClaudeAuthSwitch()

    expect(isClaudeAuthSwitchInProgress()).toBe(true)
  })

  it('still rejects overlapping account switches', () => {
    beginClaudeAuthSwitch()

    expect(() => beginClaudeAuthSwitch()).toThrow('already in progress')
  })

  it('counts seeded session ids as live until confirmed dead', () => {
    seedLiveClaudePtysFromPersistence(['seeded-pty-1', 'seeded-pty-2'])

    expect(hasLiveClaudePtys()).toBe(true)

    confirmSeededClaudeLivePtys(['seeded-pty-1'])

    expect(hasLiveClaudePtys()).toBe(true)

    confirmSeededClaudeLivePtys([])

    expect(hasLiveClaudePtys()).toBe(true)

    markClaudePtyExited('seeded-pty-1')

    expect(hasLiveClaudePtys()).toBe(false)
  })

  it('releases seeded ids the daemon no longer knows', () => {
    const removeClaudeLivePtySessionId = vi.fn()
    attachClaudeLivePtyPersistence({
      addClaudeLivePtySessionId: vi.fn(),
      removeClaudeLivePtySessionId
    })
    seedLiveClaudePtysFromPersistence(['seeded-pty-1', 'seeded-pty-2'])

    confirmSeededClaudeLivePtys(['seeded-pty-2'])

    expect(hasLiveClaudePtys()).toBe(true)
    expect(removeClaudeLivePtySessionId).toHaveBeenCalledWith('seeded-pty-1')
    expect(removeClaudeLivePtySessionId).not.toHaveBeenCalledWith('seeded-pty-2')
  })

  it('keeps a seeded id confirmed by a real spawn out of later pruning', () => {
    seedLiveClaudePtysFromPersistence(['seeded-pty-1'])
    markClaudePtySpawned('seeded-pty-1')

    confirmSeededClaudeLivePtys([])

    expect(hasLiveClaudePtys()).toBe(true)
  })

  it('notifies drain listeners only when the last live Claude PTY exits', () => {
    const onDrained = vi.fn()
    const unsubscribe = onLiveClaudePtysDrained(onDrained)
    try {
      markClaudePtySpawned('live-claude-pty')
      markClaudePtySpawned('seeded-pty-1')

      markClaudePtyExited('live-claude-pty')
      expect(onDrained).not.toHaveBeenCalled()

      markClaudePtyExited('seeded-pty-1')
      expect(onDrained).toHaveBeenCalledTimes(1)

      // Why: exits with no live PTYs left must not fire again — the drain
      // signal marks the 1 -> 0 transition, not every teardown call.
      markClaudePtyExited('seeded-pty-1')
      expect(onDrained).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it('notifies drain listeners when seed reconciliation releases the last live id', () => {
    const onDrained = vi.fn()
    const unsubscribe = onLiveClaudePtysDrained(onDrained)
    try {
      seedLiveClaudePtysFromPersistence(['seeded-pty-1'])

      confirmSeededClaudeLivePtys([])

      expect(onDrained).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it('stops notifying an unsubscribed drain listener', () => {
    const onDrained = vi.fn()
    const unsubscribe = onLiveClaudePtysDrained(onDrained)
    unsubscribe()

    markClaudePtySpawned('live-claude-pty')
    markClaudePtyExited('live-claude-pty')

    expect(onDrained).not.toHaveBeenCalled()
  })

  it('persists spawns and exits when persistence is attached', () => {
    const addClaudeLivePtySessionId = vi.fn()
    const removeClaudeLivePtySessionId = vi.fn()
    attachClaudeLivePtyPersistence({
      addClaudeLivePtySessionId,
      removeClaudeLivePtySessionId
    })

    markClaudePtySpawned('live-claude-pty')
    expect(addClaudeLivePtySessionId).toHaveBeenCalledWith('live-claude-pty')

    markClaudePtyExited('live-claude-pty')
    expect(removeClaudeLivePtySessionId).toHaveBeenCalledWith('live-claude-pty')
  })

  it('holds the refresh gate per account, so a live A does not freeze B', () => {
    markClaudePtySpawned('pty-account-a', { route: 'account-dir', accountId: 'account-a' })

    expect(hasLiveClaudePtysForAccount('account-a')).toBe(true)
    expect(hasLiveClaudePtysForAccount('account-b')).toBe(false)
    // Why: an account-pinned session reads its own dir, never the user's ~/.claude.
    expect(hasLiveClaudeSessionsOnSharedSurface()).toBe(false)
  })

  it('treats a session it cannot attribute as holding the shared credentials only', () => {
    markClaudePtySpawned('pty-legacy')

    expect(hasLiveClaudeSessionsOnSharedSurface()).toBe(true)
    // Why: counting an unattributed session against an account would restore the
    // global block where one legacy pane froze every account's refresh.
    expect(hasLiveClaudePtysForAccount('account-a')).toBe(false)
  })

  it('binds a structured child to its account too', () => {
    markClaudeStructuredChildSpawned('structured-a', {
      route: 'account-dir',
      accountId: 'account-a'
    })

    expect(hasLiveClaudePtysForAccount('account-a')).toBe(true)

    markClaudeStructuredChildExited('structured-a')

    expect(hasLiveClaudePtysForAccount('account-a')).toBe(false)
  })

  it('keeps a live session on the account it was exec-ed against', () => {
    markClaudePtySpawned('pty-account-a', { route: 'account-dir', accountId: 'account-a' })
    // A later spawn record for a live id cannot move the running CLI to another
    // config dir, so the first binding stands.
    markClaudePtySpawned('pty-account-a', { route: 'account-dir', accountId: 'account-b' })

    expect(hasLiveClaudePtysForAccount('account-a')).toBe(true)
    expect(hasLiveClaudePtysForAccount('account-b')).toBe(false)
  })

  it('attributes a restored session to the account persistence recorded for it', () => {
    seedLiveClaudePtysFromPersistence(['seeded-pty-1', 'seeded-pty-2'], {
      'seeded-pty-1': { route: 'account-dir', accountId: 'account-a' }
    })

    expect(hasLiveClaudePtysForAccount('account-a')).toBe(true)
    expect(hasLiveClaudePtysForAccount('account-b')).toBe(false)
    // Why: seeded-pty-2 has no recorded binding, so it protects the shared
    // surface without claiming an account.
    expect(hasLiveClaudeSessionsOnSharedSurface()).toBe(true)

    confirmSeededClaudeLivePtys(['seeded-pty-1'])

    expect(hasLiveClaudeSessionsOnSharedSurface()).toBe(false)
    expect(hasLiveClaudePtysForAccount('account-a')).toBe(true)
  })

  it('records the surface a spawn actually launched against', () => {
    const recordClaudeLivePtyBinding = vi.fn()
    attachClaudeLivePtyPersistence({
      addClaudeLivePtySessionId: vi.fn(),
      removeClaudeLivePtySessionId: vi.fn(),
      recordClaudeLivePtyBinding
    })

    markClaudePtySpawned(
      'pty-account-a',
      claudeLivePtyBindingForPreparation({
        configDir: '/accounts/a',
        envPatch: {},
        stripAuthEnv: true,
        accountId: 'account-a',
        configDirRoute: 'account-dir',
        provenance: 'managed:account-a'
      })
    )

    expect(recordClaudeLivePtyBinding).toHaveBeenCalledWith('pty-account-a', {
      route: 'account-dir',
      accountId: 'account-a'
    })
  })

  it('reads a launch with no managed wiring as unattributed', () => {
    expect(claudeLivePtyBindingForPreparation(null)).toEqual({ route: 'unknown' })
    expect(
      claudeLivePtyBindingForPreparation({
        configDir: '/home/user/.claude',
        envPatch: {},
        stripAuthEnv: false,
        accountId: null,
        configDirRoute: 'shared-dir',
        provenance: 'system'
      })
    ).toEqual({ route: 'shared-dir' })
  })
})
