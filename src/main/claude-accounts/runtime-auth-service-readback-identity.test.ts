import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createClaudeCredentialsWithoutEmail,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  createStore,
  readAccountRuntimeCredentials,
  readManagedCredentialsForTest,
  resetRuntimeAuthTestState,
  testState,
  writeAccountRuntimeCredentials
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Per-account isolation means a selected host account materializes into its
 * own config dir, so the user's own `~/.claude` must come out of every one of
 * these read-back scenarios exactly as untouched as it went in.
 */
function expectSharedSurfaceUntouched(): void {
  expect(existsSync(join(testState.fakeHomeDir, '.claude', '.credentials.json'))).toBe(false)
  expect(testState.scopedKeychainCredentials).toBeNull()
  expect(testState.legacyKeychainCredentials).toBeNull()
  // Why: the shared-surface runtime keychain write is the one a pinned account
  // must never reach; it is the only thing that sets this.
  expect(testState.runtimeWriteConfigDir).toBeNull()
}

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

describe('ClaudeRuntimeAuthService', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
  })

  it('reads back refreshed credentials when the Claude identity still matches', async () => {
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original')
    const refreshedCredentials = createClaudeCredentialsJson('user@example.com', 'refreshed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath, refreshedCredentials)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(refreshedCredentials)

    expectSharedSurfaceUntouched()
  })

  it('rejects wrong-shaped refreshed credentials during read-back', async () => {
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original')
    const wrongShapedRefresh = `${JSON.stringify({
      claudeAiOauth: {
        email: 'user@example.com',
        expiresAt: Date.now() + 120_000
      }
    })}\n`
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath, wrongShapedRefresh)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(originalCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(originalCredentials)

    expectSharedSurfaceUntouched()
  })

  it('reads back verified same-account credentials on first sync after restart', async () => {
    const originalCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'original',
      null,
      1_000
    )
    const refreshedCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'refreshed',
      null,
      2_000
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    writeAccountRuntimeCredentials(managedAuthPath, refreshedCredentials)
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(refreshedCredentials)

    expectSharedSurfaceUntouched()
  })

  it('rejects older same-account Claude credentials on first sync after restart', async () => {
    const staleRuntimeCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'stale',
      null,
      1_000
    )
    const managedCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'managed-newer',
      null,
      2_000
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    writeAccountRuntimeCredentials(managedAuthPath, staleRuntimeCredentials)
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(managedCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(managedCredentials)

    expectSharedSurfaceUntouched()
  })

  it('rejects runtime read-back from a different Claude identity', async () => {
    const selectedCredentials = createClaudeCredentialsJson('user@example.com', 'selected')
    const staleCredentials = createClaudeCredentialsJson('other@example.com', 'stale')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath, staleCredentials)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(selectedCredentials)

    expectSharedSurfaceUntouched()
  })

  it('rejects runtime read-back from the same Claude email in a different organization', async () => {
    const selectedCredentials = createClaudeCredentialsJson('user@example.com', 'selected', 'org-b')
    const staleCredentials = createClaudeCredentialsJson('user@example.com', 'stale', 'org-a')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { organizationUuid: 'org-b' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath, staleCredentials)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(selectedCredentials)

    expectSharedSurfaceUntouched()
  })

  it('rejects same-email Claude read-back using stored managed organization identity', async () => {
    const selectedCredentials = createClaudeCredentialsJson('user@example.com', 'selected', 'org-b')
    const staleCredentials = createClaudeCredentialsJson('user@example.com', 'stale', 'org-a')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath, staleCredentials)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(selectedCredentials)

    expectSharedSurfaceUntouched()
  })

  it('rejects same-email Claude read-back using stored oauth-account organization identity', async () => {
    const selectedCredentials = createClaudeCredentialsJson('user@example.com', 'selected')
    const staleCredentials = createClaudeCredentialsJson('user@example.com', 'stale', 'org-a')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedCredentials,
      '{"organizationUuid":"org-b"}\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath, staleCredentials)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(selectedCredentials)

    expectSharedSurfaceUntouched()
  })

  it('rejects no-email Claude read-back when organization identity conflicts', async () => {
    const selectedCredentials = createClaudeCredentialsJson('user@example.com', 'selected', 'org-b')
    const staleCredentials = createClaudeCredentialsWithoutEmail('stale', 'org-a')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { organizationUuid: 'org-b' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath, staleCredentials)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(selectedCredentials)

    expectSharedSurfaceUntouched()
  })

  it('rejects no-email refreshed credentials even when organization identity matches', async () => {
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original', 'org-a')
    const refreshedCredentials = createClaudeCredentialsWithoutEmail('refreshed', 'org-a')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { organizationUuid: 'org-a' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath, refreshedCredentials)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(originalCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(originalCredentials)

    expectSharedSurfaceUntouched()
  })

  it('preserves rejected runtime refreshes while a Claude terminal is live', async () => {
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original', 'org-a')
    const refreshedCredentials = createClaudeCredentialsWithoutEmail('refreshed', 'org-a')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { organizationUuid: 'org-a' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const { markClaudePtyExited, markClaudePtySpawned } = await import('./live-pty-gate')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    // Why: the refresh gate is per account now — only a pty bound to this
    // account's config dir owns its single-use refresh token.
    markClaudePtySpawned('live-claude-pty', { route: 'account-dir', accountId: 'account-1' })
    try {
      writeAccountRuntimeCredentials(managedAuthPath, refreshedCredentials)
      await service.syncForCurrentSelection()

      expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
      expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(refreshedCredentials)
    } finally {
      markClaudePtyExited('live-claude-pty')
    }

    await service.syncForCurrentSelection()

    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(refreshedCredentials)

    expectSharedSurfaceUntouched()
  })

  it('does not persist live runtime refreshes with conflicting organization identity', async () => {
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original', 'org-a')
    const conflictingCredentials = createClaudeCredentialsWithoutEmail('refreshed', 'org-b')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { organizationUuid: 'org-a' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const { markClaudePtyExited, markClaudePtySpawned } = await import('./live-pty-gate')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    // Why: the refresh gate is per account now — only a pty bound to this
    // account's config dir owns its single-use refresh token.
    markClaudePtySpawned('live-claude-pty', { route: 'account-dir', accountId: 'account-1' })
    try {
      writeAccountRuntimeCredentials(managedAuthPath, conflictingCredentials)
      await service.syncForCurrentSelection()

      expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(originalCredentials)
      expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(conflictingCredentials)
    } finally {
      markClaudePtyExited('live-claude-pty')
    }

    expectSharedSurfaceUntouched()
  })

  it('rematerializes managed credentials over a wiped runtime blob while a Claude terminal is live', async () => {
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original', 'org-a')
    // Why: Claude CLI wipes tokens in place (keeps identity fields) after an
    // invalid_grant refresh — the exact blob shape this regression guards.
    const parsedOriginal = JSON.parse(originalCredentials) as {
      claudeAiOauth: Record<string, unknown>
    }
    const wipedCredentials = `${JSON.stringify({
      claudeAiOauth: {
        ...parsedOriginal.claudeAiOauth,
        accessToken: '',
        refreshToken: '',
        expiresAt: 0
      }
    })}\n`
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { organizationUuid: 'org-a' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const { markClaudePtyExited, markClaudePtySpawned } = await import('./live-pty-gate')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    // Why: the refresh gate is per account now — only a pty bound to this
    // account's config dir owns its single-use refresh token.
    markClaudePtySpawned('live-claude-pty', { route: 'account-dir', accountId: 'account-1' })
    try {
      writeAccountRuntimeCredentials(managedAuthPath, wipedCredentials)
      await service.syncForCurrentSelection()

      expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(originalCredentials)
      expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(originalCredentials)
    } finally {
      markClaudePtyExited('live-claude-pty')
    }

    expectSharedSurfaceUntouched()
  })

  it('rejects unverifiable refreshed runtime credentials', async () => {
    const originalCredentials = createClaudeCredentialsWithoutEmail('original')
    const refreshedCredentials = createClaudeCredentialsWithoutEmail('refreshed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath, refreshedCredentials)
    await service.syncForCurrentSelection()
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(originalCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(originalCredentials)

    expectSharedSurfaceUntouched()
  })

  it('reads back identity-less refreshed credentials when the refresh token matches', async () => {
    const refreshToken = 'same-managed-refresh-token'
    const originalCredentials = createClaudeCredentialsWithoutEmail('original', null, {
      expiresAt: 1_000,
      refreshToken
    })
    const refreshedCredentials = createClaudeCredentialsWithoutEmail('refreshed', null, {
      expiresAt: 2_000,
      refreshToken
    })
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { organizationUuid: 'org-from-account' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath, refreshedCredentials)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(refreshedCredentials)

    expectSharedSurfaceUntouched()
  })

  it('reads back identity-less refreshed credentials when runtime oauth metadata matches', async () => {
    const originalCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'original',
      'org-a',
      1_000
    )
    const refreshedCredentials = createClaudeCredentialsWithoutEmail('refreshed', null, {
      expiresAt: 2_000,
      refreshToken: 'rotated-refresh-token'
    })
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials,
      '{"accountUuid":"account-uuid-1","emailAddress":"user@example.com","organizationUuid":"org-a"}\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, {
          email: 'user@example.com',
          organizationUuid: 'org-a'
        })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath, refreshedCredentials)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(refreshedCredentials)

    expectSharedSurfaceUntouched()
  })

  it('rules out other identity-less accounts with different refresh tokens', async () => {
    const account1RefreshToken = 'account-1-refresh-token'
    const account1OriginalCredentials = createClaudeCredentialsWithoutEmail('account-1', null, {
      expiresAt: 1_000,
      refreshToken: account1RefreshToken
    })
    const account1RefreshedCredentials = createClaudeCredentialsWithoutEmail(
      'account-1-refreshed',
      null,
      {
        expiresAt: 2_000,
        refreshToken: account1RefreshToken
      }
    )
    const account2Credentials = createClaudeCredentialsWithoutEmail('account-2', null, {
      refreshToken: 'account-2-refresh-token'
    })
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1OriginalCredentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'other@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath1, account1RefreshedCredentials)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(
      account1RefreshedCredentials
    )
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Credentials)
    expect(readAccountRuntimeCredentials(managedAuthPath1)).toBe(account1RefreshedCredentials)

    expectSharedSurfaceUntouched()
  })
})
