import {
  accountRuntimeCredentialsPath,
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  createStore,
  expectedRuntimeConfigDir,
  readAccountKeychainCredentials,
  readAccountRuntimeCredentials,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isOauthTokenExpiring, refreshClaudeOauthCredentials } from './oauth-refresh'
import { CLAUDE_LEGACY_SESSION_MIGRATION_MESSAGE } from './environment'

vi.mock('electron', () => createElectronMock())

vi.mock('./oauth-refresh', () => createOauthRefreshMock())

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

vi.mock('./keychain', () => createKeychainMock())

/**
 * Host managed accounts are isolated by their own CLAUDE_CONFIG_DIR, the way WSL
 * managed accounts already are. Two launches under two accounts must therefore
 * resolve to two different credential surfaces, and selecting one must leave the
 * other account and the user's own ~/.claude byte-identical.
 */
describe('Claude host managed account isolation', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
  })

  it('pins each host account launch to its own credential surface and touches no other', async () => {
    const sharedCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    writeFileSync(sharedCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials

    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Credentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1),
        createClaudeAccount('account-2', managedAuthPath2)
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    const preparation1 = await service.prepareForClaudeLaunch()

    expect(preparation1.configDir).toBe(managedAuthPath1)
    expect(preparation1.envPatch.CLAUDE_CONFIG_DIR).toBe(managedAuthPath1)
    // Why: Claude Code 2.1.220+ derives the Keychain service name from this var,
    // so an unpinned securestorage dir silently shares one account's Keychain item.
    expect(preparation1.envPatch.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(managedAuthPath1)
    expect(preparation1.provenance).toBe('managed:account-1')

    settings.activeClaudeManagedAccountId = 'account-2'
    const preparation2 = await service.prepareForClaudeLaunch()

    expect(preparation2.configDir).toBe(managedAuthPath2)
    expect(preparation2.envPatch.CLAUDE_CONFIG_DIR).toBe(managedAuthPath2)
    expect(preparation2.envPatch.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(managedAuthPath2)
    expect(preparation1.configDir).not.toBe(preparation2.configDir)

    // The user's own ~/.claude is never a managed account's credential surface.
    expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
    expect(testState.runtimeWriteConfigDir).toBeNull()

    // Each account's own surface carries its own credentials, and selecting
    // account-2 left account-1's alone.
    expect(testState.keychainByConfigDir.get(managedAuthPath1)).toBe(account1Credentials)
    expect(testState.keychainByConfigDir.get(managedAuthPath2)).toBe(account2Credentials)
    expect(testState.managedKeychainCredentials.get('account-1')).toBe(account1Credentials)
    expect(testState.managedKeychainCredentials.get('account-2')).toBe(account2Credentials)
    expect(expectedRuntimeConfigDir()).not.toBe(managedAuthPath1)
  })

  it('defers only the account a live Claude is bound to', async () => {
    const expiring1 = createClaudeCredentialsJson('one@example.com', 'one-expiring', null, 1_000)
    const expiring2 = createClaudeCredentialsJson('two@example.com', 'two-expiring', null, 1_000)
    const managedAuthPath1 = createManagedClaudeAuth(testState.userDataDir, 'account-1', expiring1)
    const managedAuthPath2 = createManagedClaudeAuth(testState.userDataDir, 'account-2', expiring2)
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-2'
    })
    const store = createStore(settings)
    const refreshed2 = createClaudeCredentialsJson(
      'two@example.com',
      'two-refreshed',
      null,
      9_999_999_999_999
    )
    vi.mocked(isOauthTokenExpiring).mockReturnValue(true)
    vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(refreshed2)

    const { markClaudePtyExited, markClaudePtySpawned } = await import('./live-pty-gate')
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    markClaudePtySpawned('pty-account-1', { route: 'account-dir', accountId: 'account-1' })
    try {
      // account-1's CLI owns only account-1's single-use refresh token, so
      // account-2 refreshes normally instead of waiting behind it.
      const preparation2 = await service.prepareForRateLimitFetch()

      expect(refreshClaudeOauthCredentials).toHaveBeenCalledWith(expiring2)
      expect(preparation2.managedRefreshDeferredByLivePty).toBeFalsy()
      expect(readAccountRuntimeCredentials(managedAuthPath2)).toBe(refreshed2)

      settings.activeClaudeManagedAccountId = 'account-1'
      const preparation1 = await service.prepareForRateLimitFetch()

      // Refreshing account-1 here would double-rotate the token its live CLI holds.
      expect(refreshClaudeOauthCredentials).not.toHaveBeenCalledWith(expiring1)
      expect(preparation1.managedRefreshDeferredByLivePty).toBe(true)
      expect(readAccountRuntimeCredentials(managedAuthPath1)).toBe(expiring1)
    } finally {
      markClaudePtyExited('pty-account-1')
      vi.mocked(isOauthTokenExpiring).mockReturnValue(false)
      vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(null)
    }
  })

  it('restores the per-account gate from persistence after a restart', async () => {
    const expiring1 = createClaudeCredentialsJson('one@example.com', 'one-expiring', null, 1_000)
    const managedAuthPath1 = createManagedClaudeAuth(testState.userDataDir, 'account-1', expiring1)
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    vi.mocked(isOauthTokenExpiring).mockReturnValue(true)
    vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(
      createClaudeCredentialsJson('one@example.com', 'must-not-rotate', null, 9_999_999_999_999)
    )

    const { confirmSeededClaudeLivePtys, seedLiveClaudePtysFromPersistence } =
      await import('./live-pty-gate')
    // A daemon session survived the restart; the binding persistence recorded
    // for it is what keeps the gate per-account rather than global.
    seedLiveClaudePtysFromPersistence(['daemon-pty-1'], {
      'daemon-pty-1': { route: 'account-dir', accountId: 'account-1' }
    })
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    try {
      const preparation = await service.prepareForRateLimitFetch()

      expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
      expect(preparation.managedRefreshDeferredByLivePty).toBe(true)
    } finally {
      confirmSeededClaudeLivePtys([])
      vi.mocked(isOauthTokenExpiring).mockReturnValue(false)
      vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(null)
    }
  })

  it('refuses to isolate an account a pre-isolation Claude still holds, and lets it through once that session drains', async () => {
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Credentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    // The pre-isolation build materialized account-1 into the user's own
    // ~/.claude and kept the user's credentials in the system-default snapshot.
    const sharedCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const userCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    writeFileSync(sharedCredentialsPath, account1Credentials, 'utf-8')
    testState.legacyKeychainCredentials = account1Credentials
    testState.scopedKeychainCredentials = account1Credentials
    const metadataDir = join(testState.userDataDir, 'claude-runtime-auth')
    mkdirSync(metadataDir, { recursive: true })
    writeFileSync(
      join(metadataDir, 'system-default-auth.json'),
      JSON.stringify({
        credentialsJson: userCredentials,
        configOauthAccount: null,
        keychainCredentialsJson: userCredentials,
        scopedKeychainCredentialsJson: userCredentials,
        legacyKeychainCredentialsJson: userCredentials,
        scopedKeychainCredentialsCaptured: true,
        legacyKeychainCredentialsCaptured: true,
        capturedAt: Date.now()
      }),
      'utf-8'
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { markClaudePtyExited, markClaudePtySpawned } = await import('./live-pty-gate')
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    // A session Orca cannot attribute: launched before per-account pinning, so
    // it may be reading ~/.claude — which currently carries account-1's grant.
    markClaudePtySpawned('pty-legacy')
    try {
      await expect(service.prepareForClaudeLaunch()).rejects.toThrow(
        CLAUDE_LEGACY_SESSION_MIGRATION_MESSAGE
      )
      // Nothing was copied: two CLIs on one single-use refresh token is exactly
      // the logout this refusal avoids.
      expect(readAccountKeychainCredentials(managedAuthPath1)).toBeNull()
      expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(account1Credentials)

      // An account whose grant is not the one on the shared surface is already
      // isolated, so the same legacy session must not block it.
      settings.activeClaudeManagedAccountId = 'account-2'
      const preparation2 = await service.prepareForClaudeLaunch()

      expect(preparation2.configDir).toBe(managedAuthPath2)
      expect(readAccountKeychainCredentials(managedAuthPath2)).toBe(account2Credentials)
    } finally {
      markClaudePtyExited('pty-legacy')
    }

    settings.activeClaudeManagedAccountId = 'account-1'
    const preparation1 = await service.prepareForClaudeLaunch()

    expect(preparation1.configDir).toBe(managedAuthPath1)
    expect(preparation1.legacySharedGrantBlocked).toBeFalsy()
    expect(readAccountKeychainCredentials(managedAuthPath1)).toBe(account1Credentials)
    expect(readAccountRuntimeCredentials(managedAuthPath1)).toBe(account1Credentials)
    // The user's own ~/.claude is handed back now that nothing reads it.
    expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(userCredentials)
    expect(testState.legacyKeychainCredentials).toBe(userCredentials)
    expect(testState.runtimeWriteConfigDir).toBeNull()
    expect(expectedRuntimeConfigDir()).not.toBe(managedAuthPath1)
    expect(accountRuntimeCredentialsPath(managedAuthPath1)).not.toBe(sharedCredentialsPath)
  })
})
