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
  readAccountRuntimeCredentials,
  readManagedCredentialsForTest,
  resetRuntimeAuthTestState,
  testState,
  writeAccountRuntimeCredentials
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
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

describe('preparing a Claude launch for a fixed config dir', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
  })

  it('keeps a re-authenticated non-selected account fresh against its stale dir blob', async () => {
    const reauthedCredentials = createClaudeCredentialsJson('one@example.com', 'one-reauthed')
    // Why: the pre-re-auth blob left in the account's own dir. No parseable
    // expiry on one side makes both the "fresher" and "older" comparisons
    // false, so a rotated refresh token alone would carry the cold-start
    // read-back and write this dead grant back over the fresh one.
    const staleDirCredentials = `${JSON.stringify({
      claudeAiOauth: {
        email: 'one@example.com',
        accessToken: 'one-stale',
        refreshToken: 'one-stale-refresh'
      }
    })}\n`
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      reauthedCredentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    writeAccountRuntimeCredentials(managedAuthPath1, staleDirCredentials)
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      // Account B is the selected one; A was re-authenticated in the background.
      activeClaudeManagedAccountId: 'account-2'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()
    // What registration does after writing fresh managed tokens for A.
    service.clearLastWrittenCredentialsJson('account-1')

    const preparation = await service.prepareForClaudeLaunchOnConfigDir(managedAuthPath1)

    expect(preparation.configDir).toBe(managedAuthPath1)
    expect(preparation.accountId).toBe('account-1')
    expect(preparation.configDirRoute).toBe('account-dir')
    // The re-auth survives: managed storage and the dir both carry it.
    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(reauthedCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath1)).toBe(reauthedCredentials)
    // The selected account and the user's own surface are untouched.
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Credentials)
    expect(existsSync(join(testState.fakeHomeDir, '.claude', '.credentials.json'))).toBe(false)
    expect(testState.legacyKeychainCredentials).toBeNull()
  })

  it('still adopts a genuinely newer rotation from a non-selected account dir', async () => {
    const managedCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'one',
      null,
      Date.now() + 60_000
    )
    // The account's own CLI rotated its tokens: same identity, newer expiry.
    const rotatedCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'one-rotated',
      null,
      Date.now() + 3_600_000
    )
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    writeAccountRuntimeCredentials(managedAuthPath1, rotatedCredentials)
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

    await service.prepareForClaudeLaunchOnConfigDir(managedAuthPath1)

    // Why: the guard is scoped to a pending re-auth, not a blanket refusal to
    // read back — a real CLI rotation must still reach managed storage.
    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(rotatedCredentials)
    expect(readFileSync(accountRuntimeCredentialsPath(managedAuthPath1), 'utf-8')).toBe(
      rotatedCredentials
    )
  })
})
