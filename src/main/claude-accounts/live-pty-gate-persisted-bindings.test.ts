import { afterEach, describe, expect, it } from 'vitest'
import {
  claudeLivePtyBindingForPersistedEntry,
  confirmSeededClaudeLivePtys,
  hasLiveClaudePtysForAccount,
  hasLiveClaudeSessionsOnSharedSurface,
  seedLiveClaudePtysFromPersistence,
  UNKNOWN_CLAUDE_LIVE_PTY_BINDING
} from './live-pty-gate'

describe('restoring Claude live PTY bindings from persistence', () => {
  afterEach(() => {
    confirmSeededClaudeLivePtys([])
  })

  it('keeps an account-dir row attributed to its account', () => {
    expect(
      claudeLivePtyBindingForPersistedEntry({
        sessionId: 'pty-a',
        route: 'account-dir',
        accountId: 'account-a'
      })
    ).toEqual({ route: 'account-dir', accountId: 'account-a' })
  })

  it('fails an account-dir row that names no account closed onto the shared surface', () => {
    // Why: an empty account id matches no account in the per-account gate and
    // is excluded from the shared-surface one, so the live session it stands
    // for would protect nothing and a refresh could rotate a token out from
    // under it.
    expect(
      claudeLivePtyBindingForPersistedEntry({ sessionId: 'pty-orphan', route: 'account-dir' })
    ).toBe(UNKNOWN_CLAUDE_LIVE_PTY_BINDING)

    seedLiveClaudePtysFromPersistence(['pty-orphan'], {
      'pty-orphan': claudeLivePtyBindingForPersistedEntry({
        sessionId: 'pty-orphan',
        route: 'account-dir'
      })
    })

    expect(hasLiveClaudeSessionsOnSharedSurface()).toBe(true)
    expect(hasLiveClaudePtysForAccount('account-a')).toBe(false)
  })

  it('restores WSL and shared rows unchanged', () => {
    expect(
      claudeLivePtyBindingForPersistedEntry({ sessionId: 'pty-wsl', route: 'wsl-dir' })
    ).toEqual({ route: 'wsl-dir', accountId: null })
    expect(
      claudeLivePtyBindingForPersistedEntry({ sessionId: 'pty-shared', route: 'shared-dir' })
    ).toEqual({ route: 'shared-dir' })
  })
})
