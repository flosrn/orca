import {
  accountRuntimeConfigPath,
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  createStore,
  readAccountKeychainCredentials,
  readAccountRuntimeCredentials,
  readManagedCredentialsForTest,
  readAccountRuntimeOauthAccount,
  readRuntimeOauthAccountForTest,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
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

/**
 * A sync that throws after pinning itself to an account's config dir used to
 * leave that pin set. The rollback entry point then ran the SHARED-surface
 * restore through it, writing the user's own snapshot into the account's dir —
 * on Linux/Windows that dir is the credential surface, so the account pane
 * would have run as the user's personal grant.
 */
describe('Claude runtime auth rollback after a failed account sync', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
  })

  it('restores the shared surface without touching either account dir', async () => {
    const sharedCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('owner@example.com', 'system')
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    writeFileSync(sharedCredentialsPath, systemCredentials, 'utf-8')
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
    // Why: the account's own .claude.json is the oauth identity surface a
    // pinned shared-surface restore would rewrite with the user's identity.
    writeFileSync(
      accountRuntimeConfigPath(managedAuthPath1),
      `${JSON.stringify({ oauthAccount: { accountUuid: 'account-1' } })}\n`,
      'utf-8'
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()
    expect(readAccountRuntimeCredentials(managedAuthPath1)).toBe(account1Credentials)

    // The next sync fails after it pinned itself to account-1's dir: the
    // account's own Keychain item is unwritable (a locked keychain, an EPERM).
    testState.throwScopedKeychainWrite = true
    await expect(service.syncForCurrentSelection()).rejects.toThrow('scoped keychain write failed')

    // The caller rolls the failed selection back to the user's own default.
    testState.throwScopedKeychainWrite = false
    store.updateSettings({ activeClaudeManagedAccountId: null })
    await service.forceMaterializeCurrentSelectionForRollback()

    // The rollback's subject is the user's ~/.claude, which nothing overwrote
    // while the account was isolated.
    expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBeNull()
    // Neither account's surface is the rollback's subject.
    expect(readAccountRuntimeCredentials(managedAuthPath1)).toBe(account1Credentials)
    expect(readAccountRuntimeOauthAccount(managedAuthPath1)).toEqual({ accountUuid: 'account-1' })
    expect(readAccountKeychainCredentials(managedAuthPath1)).toBe(account1Credentials)
    expect(readAccountRuntimeCredentials(managedAuthPath2)).toBe(account2Credentials)
    expect(readAccountKeychainCredentials(managedAuthPath2)).toBeNull()
    warn.mockRestore()
  })

  it('rolls a failed A to B switch back to the user default, leaving A and B intact', async () => {
    const sharedCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('owner@example.com', 'system')
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    writeFileSync(sharedCredentialsPath, systemCredentials, 'utf-8')
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
    // Why: .claude.json is the identity surface a pinned shared-surface
    // restore rewrites; give all three surfaces a distinct owner so a
    // cross-surface write shows up instead of being masked by equal values.
    writeFileSync(
      join(testState.fakeHomeDir, '.claude.json'),
      `${JSON.stringify({ oauthAccount: { accountUuid: 'system-user' } })}\n`,
      'utf-8'
    )
    writeFileSync(
      accountRuntimeConfigPath(managedAuthPath1),
      `${JSON.stringify({ oauthAccount: { accountUuid: 'account-1' } })}\n`,
      'utf-8'
    )
    writeFileSync(
      accountRuntimeConfigPath(managedAuthPath2),
      `${JSON.stringify({ oauthAccount: { accountUuid: 'account-2' } })}\n`,
      'utf-8'
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    // The switch to B fails while the sync is pinned to an account dir.
    store.updateSettings({ activeClaudeManagedAccountId: 'account-2' })
    testState.throwScopedKeychainWrite = true
    await expect(service.syncForCurrentSelection()).rejects.toThrow('scoped keychain write failed')

    // The selection handler rolls the failed switch back to the user default.
    testState.throwScopedKeychainWrite = false
    store.updateSettings({ activeClaudeManagedAccountId: null })
    await service.forceMaterializeCurrentSelectionForRollback()

    // Each account still holds its OWN grant on its OWN surface, and the
    // user's ~/.claude still holds theirs.
    expect(readAccountRuntimeCredentials(managedAuthPath1)).toBe(account1Credentials)
    expect(readAccountRuntimeCredentials(managedAuthPath2)).toBe(account2Credentials)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1Credentials)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Credentials)
    expect(readAccountRuntimeOauthAccount(managedAuthPath1)).toEqual({ accountUuid: 'account-1' })
    expect(readAccountRuntimeOauthAccount(managedAuthPath2)).toEqual({ accountUuid: 'account-2' })
    expect(readRuntimeOauthAccountForTest()).toEqual({ accountUuid: 'system-user' })
    expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBeNull()
    expect(testState.runtimeWriteConfigDir).toBeNull()
    warn.mockRestore()
  })

  it('refuses a shared-surface restore that would run against an account dir', async () => {
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath1)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    // Why: the invariant is what makes every shared-surface helper safe, so it
    // is asserted where the damage would happen rather than left to callers.
    const pinned = service as unknown as {
      pinnedAccountConfigDir: string | null
      restoreSystemDefaultSnapshot: (credentialsJson?: string | null) => Promise<void>
    }
    pinned.pinnedAccountConfigDir = managedAuthPath1
    await expect(pinned.restoreSystemDefaultSnapshot(account1Credentials)).rejects.toThrow(
      'restoreSystemDefaultSnapshot must run against the shared surface'
    )
    expect(readAccountRuntimeCredentials(managedAuthPath1)).toBe(account1Credentials)
  })
})
