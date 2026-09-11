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
  readAccountKeychainCredentials,
  readAccountRuntimeCredentials,
  readManagedCredentialsForTest,
  readRuntimeOauthAccountForTest,
  resetRuntimeAuthTestState,
  setAccountKeychainCredentials,
  testState,
  writeAccountRuntimeCredentials
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

  it('reads back refreshed file credentials when keychain reads fail', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original')
    const refreshedCredentials = createClaudeCredentialsJson('user@example.com', 'refreshed')
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    // The account's own Claude CLI rotated its tokens inside the account's
    // config dir, which is the only runtime surface a selected account has.
    writeAccountRuntimeCredentials(managedAuthPath, refreshedCredentials)
    testState.throwScopedKeychainRead = true
    testState.throwLegacyKeychainRead = true
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(refreshedCredentials)
    expect(readAccountKeychainCredentials(managedAuthPath)).toBe(refreshedCredentials)
    // Why: the user's own ~/.claude is not this account's surface — isolation
    // means the managed rotation never lands there, not even as a new file.
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
    expect(testState.legacyKeychainCredentials).toBeNull()
    expect(testState.runtimeWriteConfigDir).toBeNull()
    warn.mockRestore()
  })

  it('captures a fresh system-default snapshot when re-entering managed mode', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials1 = createClaudeCredentialsJson('system1@example.com', 'system1')
    const systemCredentials2 = createClaudeCredentialsJson('system2@example.com', 'system2')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials1, 'utf-8')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()
    writeFileSync(runtimeCredentialsPath, systemCredentials2, 'utf-8')

    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials2)
  })

  it('leaves every user credential surface intact across managed enter and leave cycles', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials1 = createClaudeCredentialsJson('system1@example.com', 'system1')
    const systemCredentials2 = createClaudeCredentialsJson('system2@example.com', 'system2')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const systemOauthAccount1 = { accountUuid: 'system-account-1' }
    const systemOauthAccount2 = { accountUuid: 'system-account-2' }
    writeFileSync(runtimeCredentialsPath, systemCredentials1, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount1 })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = systemCredentials1
    testState.legacyKeychainCredentials = systemCredentials1
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    // The user logged their own ~/.claude into a different account between the
    // two managed cycles: file, oauth snapshot and both Keychain items move.
    writeFileSync(runtimeCredentialsPath, systemCredentials2, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount2 })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = systemCredentials2
    testState.legacyKeychainCredentials = systemCredentials2
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    // Why: with the account materializing into its own config dir, entering and
    // leaving managed mode is a no-op on every surface the user owns — no
    // restore of a stale snapshot over the login they made in between.
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials2)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount2)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials2)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials2)
    expect(testState.runtimeWriteConfigDir).toBeNull()
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(managedCredentials)
    expect(readAccountKeychainCredentials(managedAuthPath)).toBe(managedCredentials)
  })

  it('reads back refreshed credentials for the outgoing Claude account before switching', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Original = createClaudeCredentialsJson('one@example.com', 'one-original')
    const account1Refreshed = createClaudeCredentialsJson('one@example.com', 'one-refreshed')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Original
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    // account-1's Claude refreshed in account-1's own dir; switching away must
    // pin that dir to collect the rotation before account-2 takes over.
    writeAccountRuntimeCredentials(managedAuthPath1, account1Refreshed)
    settings.activeClaudeManagedAccountId = 'account-2'
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1Refreshed)
    // Why: the incoming account materializes into its own dir, so account-1's
    // surface keeps its rotation instead of being overwritten by account-2.
    expect(readAccountRuntimeCredentials(managedAuthPath1)).toBe(account1Refreshed)
    expect(readAccountRuntimeCredentials(managedAuthPath2)).toBe(account2Credentials)
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
  })

  it('switches accounts without persisting unverified live runtime credentials', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Original = createClaudeCredentialsJson('one@example.com', 'one-original', 'org-a')
    const unverifiedLiveCredentials = createClaudeCredentialsWithoutEmail('one-live', 'org-b')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two', 'org-c')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Original
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, {
          email: 'one@example.com',
          organizationUuid: 'org-a'
        }),
        createClaudeAccount('account-2', managedAuthPath2, {
          email: 'two@example.com',
          organizationUuid: 'org-c'
        })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const { markClaudePtyExited, markClaudePtySpawned } = await import('./live-pty-gate')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    // Why: the live session must be attributed to the account it launched
    // under, or the outgoing read-back treats its blob as an unowned surface.
    markClaudePtySpawned('live-claude-pty', { route: 'account-dir', accountId: 'account-1' })
    try {
      writeAccountRuntimeCredentials(managedAuthPath1, unverifiedLiveCredentials)
      settings.activeClaudeManagedAccountId = 'account-2'

      await service.syncForCurrentSelection()
    } finally {
      markClaudePtyExited('live-claude-pty')
    }

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1Original)
    expect(readAccountRuntimeCredentials(managedAuthPath2)).toBe(account2Credentials)
    if (process.platform === 'darwin') {
      expect(readAccountKeychainCredentials(managedAuthPath2)).toBe(account2Credentials)
      // Why: a pinned account never publishes to the shared or unscoped items.
      expect(testState.scopedKeychainCredentials).toBeNull()
      expect(testState.legacyKeychainCredentials).toBeNull()
    }
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
  })

  it('routes refreshed Claude credentials to the matching managed account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Original = createClaudeCredentialsJson('one@example.com', 'one-original')
    const account1Refreshed = createClaudeCredentialsJson('one@example.com', 'one-refreshed')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Original
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-2'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    // A refresh that belongs to account-1 turned up on the selected account's
    // own surface. Persist it to account-1, then restore account-2 there.
    writeAccountRuntimeCredentials(managedAuthPath2, account1Refreshed)
    setAccountKeychainCredentials(managedAuthPath2, account1Refreshed)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1Refreshed)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Credentials)
    expect(readAccountRuntimeCredentials(managedAuthPath2)).toBe(account2Credentials)
    if (process.platform === 'darwin') {
      expect(readAccountKeychainCredentials(managedAuthPath2)).toBe(account2Credentials)
      expect(testState.scopedKeychainCredentials).toBeNull()
      expect(testState.legacyKeychainCredentials).toBeNull()
    }
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
  })

  it('rejects stale cold-start read-back for inactive matching account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1ManagedNewer = createClaudeCredentialsJson(
      'one@example.com',
      'one-managed-newer',
      null,
      5_000
    )
    const account1RuntimeStale = createClaudeCredentialsJson(
      'one@example.com',
      'one-runtime-stale',
      null,
      2_000
    )
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two', null, 1_000)
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1ManagedNewer
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    // A stale account-1 blob left behind on the selected account's surface.
    writeAccountRuntimeCredentials(managedAuthPath2, account1RuntimeStale)
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-2'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1ManagedNewer)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Credentials)
    expect(readAccountRuntimeCredentials(managedAuthPath2)).toBe(account2Credentials)
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
  })

  it('rejects ambiguous Claude read-back instead of choosing a managed account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson('same@example.com', 'same-original')
    const refreshedCredentials = createClaudeCredentialsJson('same@example.com', 'same-refreshed')
    const activeCredentials = createClaudeCredentialsJson('active@example.com', 'active')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      originalCredentials
    )
    const managedAuthPath3 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-3',
      activeCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'same@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'same@example.com' }),
        createClaudeAccount('account-3', managedAuthPath3, { email: 'active@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-3'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath3, refreshedCredentials)
    setAccountKeychainCredentials(managedAuthPath3, refreshedCredentials)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(originalCredentials)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(originalCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath3)).toBe(activeCredentials)
    if (process.platform === 'darwin') {
      expect(readAccountKeychainCredentials(managedAuthPath3)).toBe(activeCredentials)
      expect(testState.scopedKeychainCredentials).toBeNull()
      expect(testState.legacyKeychainCredentials).toBeNull()
    }
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
  })

  it('rejects same-email read-back when another account needs organization proof', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const noOrgCredentials = createClaudeCredentialsJson('same@example.com', 'no-org')
    const orgCredentials = createClaudeCredentialsJson('same@example.com', 'org', 'org-b')
    const refreshedWithoutOrg = createClaudeCredentialsJson('same@example.com', 'refreshed')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      noOrgCredentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      orgCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'same@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, {
          email: 'same@example.com',
          organizationUuid: 'org-b'
        })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath1, refreshedWithoutOrg)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(noOrgCredentials)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(orgCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath1)).toBe(noOrgCredentials)
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
  })

  it('ignores unrelated org-scoped accounts when reading back no-org credentials', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const account1RefreshedCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'one-refreshed'
    )
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two', 'org-b')
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
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, {
          email: 'two@example.com',
          organizationUuid: 'org-b'
        })
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
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
  })

  it('rejects same-email read-back with conflicting organization for no-org accounts', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const noOrgCredentials = createClaudeCredentialsJson('same@example.com', 'no-org')
    const orgCredentials = createClaudeCredentialsJson('same@example.com', 'org', 'org-b')
    const conflictingOrgCredentials = createClaudeCredentialsJson(
      'same@example.com',
      'conflicting-org',
      'org-c'
    )
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      noOrgCredentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      orgCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'same@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, {
          email: 'same@example.com',
          organizationUuid: 'org-b'
        })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeAccountRuntimeCredentials(managedAuthPath1, conflictingOrgCredentials)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(noOrgCredentials)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(orgCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath1)).toBe(noOrgCredentials)
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
  })
})
