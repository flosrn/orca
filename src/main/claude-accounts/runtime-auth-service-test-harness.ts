import { vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
export const hostPlatform = process.platform
export const testState = {
  userDataDir: '',
  fakeHomeDir: '',
  activeKeychainCredentials: null as string | null,
  scopedKeychainCredentials: null as string | null,
  legacyKeychainCredentials: null as string | null,
  throwScopedKeychainRead: false,
  throwLegacyKeychainRead: false,
  throwRuntimeKeychainWrite: false,
  throwLegacyRuntimeKeychainWrite: false,
  throwScopedKeychainWrite: false,
  runtimeWriteConfigDir: null as string | null,
  // Why: per-account host isolation gives every managed account its own
  // CLAUDE_CONFIG_DIR, so the scoped active-Claude keychain item is per-dir.
  // `scopedKeychainCredentials` stays the shared ~/.claude item's value.
  keychainByConfigDir: new Map<string, string | null>(),
  managedKeychainCredentials: new Map<string, string>()
}

export function expectedRuntimeConfigDir(): string {
  return join(testState.fakeHomeDir, '.claude')
}

export function createElectronMock() {
  return {
    app: {
      getPath: () => testState.userDataDir
    }
  }
}

// Why: these tests exercise materialize/read-back/snapshot logic, not the
// network OAuth refresh (covered by oauth-refresh.test.ts). Default the token
// to "not expiring" so the proactive switch-in refresh never fires here and
// existing expectations hold; individual tests can override these mocks.
export function createOauthRefreshMock() {
  return {
    isOauthTokenExpiring: vi.fn(() => false),
    refreshClaudeOauthCredentials: vi.fn(async () => null)
  }
}

export function createKeychainMock() {
  return {
    readActiveClaudeKeychainCredentials: vi.fn(async (configDir?: string) => {
      if (configDir) {
        if (configDir !== expectedRuntimeConfigDir()) {
          // Real keychain.ts falls back to the unscoped service on a miss.
          return testState.keychainByConfigDir.get(configDir) ?? testState.legacyKeychainCredentials
        }
        return testState.scopedKeychainCredentials ?? testState.legacyKeychainCredentials
      }
      return testState.legacyKeychainCredentials
    }),
    writeActiveClaudeKeychainCredentials: vi.fn(async (contents: string, configDir?: string) => {
      if (configDir) {
        if (testState.throwScopedKeychainWrite) {
          throw new Error('scoped keychain write failed')
        }
        if (configDir === expectedRuntimeConfigDir()) {
          testState.scopedKeychainCredentials = contents
        } else {
          // Scoped-only on purpose: this write must never reach the unscoped
          // `Claude Code-credentials` item another account/default reads.
          testState.keychainByConfigDir.set(configDir, contents)
          return
        }
      } else {
        testState.legacyKeychainCredentials = contents
      }
      testState.activeKeychainCredentials = contents
    }),
    deleteActiveClaudeKeychainCredentials: vi.fn(async () => {
      testState.scopedKeychainCredentials = null
      testState.legacyKeychainCredentials = null
      testState.activeKeychainCredentials = null
    }),
    deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async (configDir?: string) => {
      if (configDir) {
        if (configDir === expectedRuntimeConfigDir()) {
          testState.scopedKeychainCredentials = null
        } else {
          testState.keychainByConfigDir.set(configDir, null)
          return
        }
      } else {
        testState.legacyKeychainCredentials = null
      }
      testState.activeKeychainCredentials = null
    }),
    readActiveClaudeKeychainCredentialsStrict: vi.fn(async (configDir?: string) =>
      configDir
        ? (() => {
            if (testState.throwScopedKeychainRead) {
              throw new Error('scoped keychain read failed')
            }
            return configDir === expectedRuntimeConfigDir()
              ? testState.scopedKeychainCredentials
              : (testState.keychainByConfigDir.get(configDir) ?? null)
          })()
        : (() => {
            if (testState.throwLegacyKeychainRead) {
              throw new Error('legacy keychain read failed')
            }
            return testState.legacyKeychainCredentials
          })()
    ),
    writeActiveClaudeKeychainCredentialsForRuntime: vi.fn(
      async (contents: string, configDir: string) => {
        if (configDir !== expectedRuntimeConfigDir()) {
          throw new Error(`Unexpected Claude config dir: ${configDir}`)
        }
        if (testState.throwRuntimeKeychainWrite) {
          throw new Error('runtime keychain write failed')
        }
        testState.runtimeWriteConfigDir = configDir
        testState.scopedKeychainCredentials = contents
        if (testState.throwLegacyRuntimeKeychainWrite) {
          throw new Error('legacy runtime keychain write failed')
        }
        testState.legacyKeychainCredentials = contents
        testState.activeKeychainCredentials = contents
      }
    ),
    readManagedClaudeKeychainCredentials: vi.fn(
      async (accountId: string) => testState.managedKeychainCredentials.get(accountId) ?? null
    ),
    writeManagedClaudeKeychainCredentials: vi.fn(async (accountId: string, contents: string) => {
      testState.managedKeychainCredentials.set(accountId, contents)
    })
  }
}

export function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

/** Shared `beforeEach` body: fresh platform, module registry, and temp homes. */
export function resetRuntimeAuthTestState(): void {
  setPlatform('darwin')
  vi.resetModules()
  vi.clearAllMocks()
  testState.activeKeychainCredentials = null
  testState.scopedKeychainCredentials = null
  testState.legacyKeychainCredentials = null
  testState.throwScopedKeychainRead = false
  testState.throwLegacyKeychainRead = false
  testState.throwRuntimeKeychainWrite = false
  testState.throwLegacyRuntimeKeychainWrite = false
  testState.throwScopedKeychainWrite = false
  testState.runtimeWriteConfigDir = null
  testState.keychainByConfigDir.clear()
  testState.managedKeychainCredentials.clear()
  // Why: managed-path ownership resolves through realpath, so a non-canonical
  // temp root (/var → /private/var on macOS) would make every account dir
  // compare unequal to the path the service hands a launch.
  testState.userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-claude-runtime-')))
  testState.fakeHomeDir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-claude-home-')))
  mkdirSync(join(testState.fakeHomeDir, '.claude'), { recursive: true })
}

/** Shared `afterEach` body. */
export function cleanupRuntimeAuthTestState(): void {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  rmSync(testState.userDataDir, { recursive: true, force: true })
  rmSync(testState.fakeHomeDir, { recursive: true, force: true })
}

export function createSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    ...getDefaultSettings(testState.fakeHomeDir),
    ...overrides
  }
}

export function createStore(settings: GlobalSettings) {
  return {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = {
        ...settings,
        ...updates,
        notifications: {
          ...settings.notifications,
          ...updates.notifications
        }
      }
      return settings
    })
  }
}

export function createManagedClaudeAuth(
  rootDir: string,
  accountId: string,
  credentialsJson: string,
  oauthAccountJson = `{"accountUuid":"${accountId}"}\n`
): string {
  const managedAuthPath = join(rootDir, 'claude-accounts', accountId, 'auth')
  mkdirSync(managedAuthPath, { recursive: true })
  writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), `${accountId}\n`, 'utf-8')
  writeFileSync(join(managedAuthPath, '.credentials.json'), credentialsJson, 'utf-8')
  writeFileSync(join(managedAuthPath, 'oauth-account.json'), oauthAccountJson, 'utf-8')
  testState.managedKeychainCredentials.set(accountId, credentialsJson)
  return managedAuthPath
}

export function createClaudeAccount(
  id: string,
  managedAuthPath: string,
  overrides: Partial<ClaudeManagedAccount> = {}
): ClaudeManagedAccount {
  return {
    id,
    email: 'user@example.com',
    managedAuthPath,
    authMethod: 'subscription-oauth',
    organizationUuid: null,
    organizationName: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

export function createClaudeCredentialsJson(
  email: string,
  accessToken: string,
  organizationUuid: string | null = null,
  expiresAt = Date.now() + 60_000
): string {
  return `${JSON.stringify({
    claudeAiOauth: {
      email,
      ...(organizationUuid ? { organizationUuid } : {}),
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      expiresAt
    }
  })}\n`
}

export function createClaudeCredentialsWithoutEmail(
  accessToken: string,
  organizationUuid: string | null = null,
  options: { expiresAt?: number; refreshToken?: string } = {}
): string {
  return `${JSON.stringify({
    claudeAiOauth: {
      ...(organizationUuid ? { organizationUuid } : {}),
      accessToken,
      refreshToken: options.refreshToken ?? `${accessToken}-refresh`,
      expiresAt: options.expiresAt ?? Date.now() + 60_000
    }
  })}\n`
}

export function readManagedCredentialsForTest(
  accountId: string,
  managedAuthPath: string
): string | null {
  if (process.platform === 'darwin') {
    return testState.managedKeychainCredentials.get(accountId) ?? null
  }
  return readFileSync(join(managedAuthPath, '.credentials.json'), 'utf-8')
}

export function readRuntimeOauthAccountForTest(): unknown {
  const configPath = join(testState.fakeHomeDir, '.claude.json')
  if (!existsSync(configPath)) {
    return null
  }
  return (
    (JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>).oauthAccount ?? null
  )
}

/**
 * The surface a selected HOST managed account materializes into: its own
 * config dir. The user's `~/.claude` (see `expectedRuntimeConfigDir`) is never
 * that surface, which is what per-account isolation buys.
 */
export function accountRuntimeCredentialsPath(managedAuthPath: string): string {
  return join(managedAuthPath, '.credentials.json')
}

export function accountRuntimeConfigPath(managedAuthPath: string): string {
  return join(managedAuthPath, '.claude.json')
}

export function readAccountRuntimeCredentials(managedAuthPath: string): string | null {
  const path = accountRuntimeCredentialsPath(managedAuthPath)
  return existsSync(path) ? readFileSync(path, 'utf-8') : null
}

/** Simulates the account's own Claude CLI rewriting its credentials file. */
export function writeAccountRuntimeCredentials(managedAuthPath: string, contents: string): void {
  mkdirSync(managedAuthPath, { recursive: true })
  writeFileSync(accountRuntimeCredentialsPath(managedAuthPath), contents, 'utf-8')
}

export function readAccountRuntimeOauthAccount(managedAuthPath: string): unknown {
  const configPath = accountRuntimeConfigPath(managedAuthPath)
  if (!existsSync(configPath)) {
    return null
  }
  return (
    (JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>).oauthAccount ?? null
  )
}

/** The account's dir-scoped Keychain item — distinct from both the shared
 *  scoped item and the unscoped `Claude Code-credentials` one. */
export function readAccountKeychainCredentials(managedAuthPath: string): string | null {
  return testState.keychainByConfigDir.get(managedAuthPath) ?? null
}

export function setAccountKeychainCredentials(managedAuthPath: string, contents: string): void {
  testState.keychainByConfigDir.set(managedAuthPath, contents)
}
