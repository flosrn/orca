import {
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
  readAccountRuntimeOauthAccount,
  readRuntimeOauthAccountForTest,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('treats corrupt system-default snapshots as missing and clears owned runtime auth', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(snapshotPath, '{not-json', 'utf-8')
    writeFileSync(runtimeCredentialsPath, managedCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'account-1' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = managedCredentials
    testState.legacyKeychainCredentials = managedCredentials
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(existsSync(snapshotPath)).toBe(false)
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
    expect(readRuntimeOauthAccountForTest()).toBeNull()
    expect(testState.scopedKeychainCredentials).toBeNull()
    expect(testState.legacyKeychainCredentials).toBeNull()
    warn.mockRestore()
  })

  it('treats wrong-shaped system-default snapshots as missing and clears owned runtime auth', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        credentialsJson: { token: 'system' },
        keychainCredentialsJson: managedCredentials,
        scopedKeychainCredentialsJson: { token: 'scoped' },
        legacyKeychainCredentialsJson: managedCredentials,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(runtimeCredentialsPath, managedCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'account-1' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = managedCredentials
    testState.legacyKeychainCredentials = managedCredentials
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(existsSync(snapshotPath)).toBe(false)
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
    expect(readRuntimeOauthAccountForTest()).toBeNull()
    expect(testState.scopedKeychainCredentials).toBeNull()
    expect(testState.legacyKeychainCredentials).toBeNull()
    warn.mockRestore()
  })

  it('treats snapshots missing all keychain credential fields as invalid', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        credentialsJson: null,
        configOauthAccount: null,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(runtimeCredentialsPath, managedCredentials, 'utf-8')
    testState.scopedKeychainCredentials = managedCredentials
    testState.legacyKeychainCredentials = managedCredentials
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(existsSync(snapshotPath)).toBe(false)
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
    expect(testState.scopedKeychainCredentials).toBeNull()
    expect(testState.legacyKeychainCredentials).toBeNull()
    warn.mockRestore()
  })

  it('treats snapshots missing credentialsJson as invalid and clears missing-managed runtime auth', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const staleManagedCredentials = createClaudeCredentialsJson('managed@example.com', 'managed')
    const managedAuthPath = join(testState.userDataDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        configOauthAccount: null,
        keychainCredentialsJson: null,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(runtimeCredentialsPath, staleManagedCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'account-1' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = staleManagedCredentials
    testState.legacyKeychainCredentials = staleManagedCredentials
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'managed@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.prepareForClaudeLaunch()

    expect(existsSync(snapshotPath)).toBe(true)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(staleManagedCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual({ accountUuid: 'account-1' })
    expect(testState.scopedKeychainCredentials).toBe(staleManagedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(staleManagedCredentials)
    warn.mockRestore()
  })

  it('clears missing-managed oauth metadata when only keychain proves ownership', async () => {
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const staleManagedCredentials = createClaudeCredentialsJson('managed@example.com', 'managed')
    const managedAuthPath = join(testState.userDataDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'account-1' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = staleManagedCredentials
    testState.legacyKeychainCredentials = staleManagedCredentials
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'managed@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.prepareForClaudeLaunch()

    expect(readRuntimeOauthAccountForTest()).toEqual({ accountUuid: 'account-1' })
    expect(testState.scopedKeychainCredentials).toBe(staleManagedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(staleManagedCredentials)
  })

  it('preserves missing-managed oauth metadata without credential ownership proof', async () => {
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const externalCredentials = createClaudeCredentialsJson('external@example.com', 'external')
    const managedAuthPath = join(testState.userDataDir, 'claude-accounts', 'account-1', 'auth')
    const managedOauthAccount = { accountUuid: 'account-1' }
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: managedOauthAccount })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = externalCredentials
    testState.legacyKeychainCredentials = externalCredentials
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'managed@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.prepareForClaudeLaunch()

    expect(readRuntimeOauthAccountForTest()).toEqual(managedOauthAccount)
    expect(testState.scopedKeychainCredentials).toBe(externalCredentials)
    expect(testState.legacyKeychainCredentials).toBe(externalCredentials)
  })

  it('preserves invalid external runtime oauth metadata when deselecting', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(runtimeConfigPath, `${JSON.stringify({})}\n`, 'utf-8')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials,
      'null\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeConfigPath, '{not-json', 'utf-8')
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe('{not-json')
  })

  it('preserves the invalid shared runtime config while materializing into the account', async () => {
    const sharedCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const sharedConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(sharedCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(sharedConfigPath, '{not-json', 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
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

    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(managedCredentials)
    expect(readAccountKeychainCredentials(managedAuthPath)).toBe(managedCredentials)
    expect(readAccountRuntimeOauthAccount(managedAuthPath)).toEqual({ accountUuid: 'account-1' })
    // Why: unparseable config is unknown external state — the account gets its
    // own file rather than Orca rewriting the user's.
    expect(readFileSync(sharedConfigPath, 'utf-8')).toBe('{not-json')
    expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)

    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(readFileSync(sharedConfigPath, 'utf-8')).toBe('{not-json')
  })

  it('preserves the non-object shared runtime config while materializing into the account', async () => {
    const sharedCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const sharedConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(sharedCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(sharedConfigPath, '[]', 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
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

    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(managedCredentials)
    expect(readAccountKeychainCredentials(managedAuthPath)).toBe(managedCredentials)
    expect(readFileSync(sharedConfigPath, 'utf-8')).toBe('[]')
    expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('does not use an account-surface oauth write as ownership proof on deselect', async () => {
    const sharedCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const sharedConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const externalCredentials = createClaudeCredentialsJson('external@example.com', 'external')
    const managedOauthAccount = { accountUuid: 'account-1' }
    writeFileSync(sharedCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(sharedConfigPath, '{not-json', 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials,
      `${JSON.stringify(managedOauthAccount)}\n`
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    expect(readAccountRuntimeOauthAccount(managedAuthPath)).toEqual(managedOauthAccount)

    // The user logs in on their own surface, as the same account.
    writeFileSync(sharedCredentialsPath, externalCredentials, 'utf-8')
    writeFileSync(
      sharedConfigPath,
      `${JSON.stringify({ oauthAccount: managedOauthAccount })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = externalCredentials
    testState.legacyKeychainCredentials = externalCredentials
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(externalCredentials)
    // Why: the only oauth write this selection made went to the account's own
    // config dir, so matching metadata in ~/.claude.json is the user's, not
    // Orca's to clear.
    expect(readRuntimeOauthAccountForTest()).toEqual(managedOauthAccount)
    expect(testState.scopedKeychainCredentials).toBe(externalCredentials)
    expect(testState.legacyKeychainCredentials).toBe(externalCredentials)
  })

  it('preserves external oauth logout when managed oauth metadata is null', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'system-account' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials,
      'null\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    rmSync(runtimeCredentialsPath, { force: true })
    testState.scopedKeychainCredentials = null
    testState.legacyKeychainCredentials = null
    writeFileSync(runtimeConfigPath, `${JSON.stringify({})}\n`, 'utf-8')
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(existsSync(runtimeCredentialsPath)).toBe(false)
    expect(readRuntimeOauthAccountForTest()).toBeNull()
    expect(testState.scopedKeychainCredentials).toBeNull()
    expect(testState.legacyKeychainCredentials).toBeNull()
  })

  it('restores the shared oauth metadata from the snapshot when releasing the legacy surface', async () => {
    const sharedCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const sharedConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const systemOauthAccount = { accountUuid: 'system-account', emailAddress: 'system@example.com' }
    // Why: a pre-isolation build materialized this account into ~/.claude and
    // captured the user's own auth; selecting it now hands that back before
    // pinning, metadata included.
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        credentialsJson: systemCredentials,
        configOauthAccount: systemOauthAccount,
        keychainCredentialsJson: systemCredentials,
        scopedKeychainCredentialsJson: systemCredentials,
        legacyKeychainCredentialsJson: systemCredentials,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(sharedCredentialsPath, managedCredentials, 'utf-8')
    writeFileSync(
      sharedConfigPath,
      '{"oauthAccount":{"emailAddress":"user@example.com","accountUuid":"account-1"}}\n',
      'utf-8'
    )
    testState.scopedKeychainCredentials = managedCredentials
    testState.legacyKeychainCredentials = managedCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials,
      '{"accountUuid":"account-1","emailAddress":"user@example.com"}\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
    expect(readAccountRuntimeCredentials(managedAuthPath)).toBe(managedCredentials)
    expect(readAccountKeychainCredentials(managedAuthPath)).toBe(managedCredentials)
  })

  it('restores owned oauth metadata during rollback after removing the added account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const systemOauthAccount = { accountUuid: 'system-account' }
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount })}\n`,
      'utf-8'
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials,
      '{"accountUuid":"account-1"}\n'
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
    settings.claudeManagedAccounts = []
    await service.forceMaterializeCurrentSelectionForRollback()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount)
  })
})
