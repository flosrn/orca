import {
  cleanupRuntimeAuthTestState,
  createElectronMock,
  createManagedClaudeAuth,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'

/** Dir-scoped `Claude Code-credentials-<sha8(dir)>` items, keyed by config dir,
 *  plus Orca's own managed items keyed by account id. */
const keychainState = {
  activeByConfigDir: new Map<string, string>(),
  managedByAccountId: new Map<string, string>(),
  /** Whether the account directory still existed when the scoped delete ran —
   *  the service-name aliases resolve through its realpath. */
  configDirExistedOnDelete: new Map<string, boolean>()
}

vi.mock('electron', () => createElectronMock())

vi.mock('./keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async (configDir?: string) => {
    if (!configDir) {
      throw new Error('Removing an account must never touch the unscoped Claude item')
    }
    keychainState.configDirExistedOnDelete.set(configDir, existsSync(configDir))
    keychainState.activeByConfigDir.delete(configDir)
  }),
  deleteManagedClaudeKeychainCredentials: vi.fn(async (accountId: string) => {
    keychainState.managedByAccountId.delete(accountId)
  }),
  readManagedClaudeKeychainCredentials: vi.fn(
    async (accountId: string) => keychainState.managedByAccountId.get(accountId) ?? null
  ),
  writeManagedClaudeKeychainCredentials: vi.fn(async (accountId: string, contents: string) => {
    keychainState.managedByAccountId.set(accountId, contents)
  })
}))

describe('ClaudeManagedAuthStorage.remove', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
    keychainState.activeByConfigDir.clear()
    keychainState.managedByAccountId.clear()
    keychainState.configDirExistedOnDelete.clear()
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
  })

  it('deletes the account dir-scoped login Keychain item and leaves other accounts alone', async () => {
    const managedAuthPath1 = createManagedClaudeAuth(testState.userDataDir, 'account-1', '{}\n')
    const managedAuthPath2 = createManagedClaudeAuth(testState.userDataDir, 'account-2', '{}\n')
    // Every sync of a pinned account publishes its live credentials here.
    keychainState.activeByConfigDir.set(managedAuthPath1, 'account-1-live')
    keychainState.activeByConfigDir.set(managedAuthPath2, 'account-2-live')
    keychainState.managedByAccountId.set('account-1', 'account-1-managed')
    keychainState.managedByAccountId.set('account-2', 'account-2-managed')

    const { ClaudeManagedAuthStorage } = await import('./claude-managed-auth-storage')
    await new ClaudeManagedAuthStorage().remove('account-1', managedAuthPath1)

    // The refresh token is gone from the login Keychain, not just from disk.
    expect(keychainState.activeByConfigDir.has(managedAuthPath1)).toBe(false)
    expect(keychainState.managedByAccountId.has('account-1')).toBe(false)
    // Why: the item's service name is derived from the directory's realpath,
    // so the delete only resolves while the directory is still there.
    expect(keychainState.configDirExistedOnDelete.get(managedAuthPath1)).toBe(true)
    expect(existsSync(managedAuthPath1)).toBe(false)

    // The other account keeps both of its surfaces.
    expect(keychainState.activeByConfigDir.get(managedAuthPath2)).toBe('account-2-live')
    expect(keychainState.managedByAccountId.get('account-2')).toBe('account-2-managed')
    expect(existsSync(managedAuthPath2)).toBe(true)
  })

  it('touches no Keychain item scoped to a directory Orca does not own', async () => {
    const managedAuthPath = createManagedClaudeAuth(testState.userDataDir, 'account-1', '{}\n')
    keychainState.activeByConfigDir.set(managedAuthPath, 'account-1-live')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeManagedAuthStorage } = await import('./claude-managed-auth-storage')
    // An account id that does not match the directory's ownership marker.
    await new ClaudeManagedAuthStorage().remove('account-9', managedAuthPath)

    expect(keychainState.activeByConfigDir.get(managedAuthPath)).toBe('account-1-live')
    expect(existsSync(managedAuthPath)).toBe(true)
    warn.mockRestore()
  })
})
