import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  readAccountKeychainCredentials,
  readAccountRuntimeCredentials,
  readManagedCredentialsForTest,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { initDataPath } from '../persistence/loading-store/user-data-path'
import type { ClaudeLivePtyBinding } from './live-pty-gate'

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
 * A stand-in for the Claude CLI, run as a real long-lived child process so two
 * of them are genuinely alive at once. It answers commands on stdin with what
 * the credential surface its env pinned it to currently holds — and reports a
 * fingerprint, never a token: a fixture that echoes credentials teaches the
 * suite to leak them.
 *
 * `rotate` reproduces the one CLI behaviour this isolation is about: the
 * process rewrites its own `.credentials.json` in the directory it was handed,
 * and nowhere else.
 */
const FAKE_CLAUDE_CLI = `
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const credentialsPath = join(configDir, '.credentials.json')

function readCredentials() {
  return existsSync(credentialsPath) ? JSON.parse(readFileSync(credentialsPath, 'utf-8')) : null
}

function report(credentials) {
  const oauth = credentials ? credentials.claudeAiOauth : null
  process.stdout.write(
    JSON.stringify({
      configDir,
      securestorageConfigDir: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR || null,
      apiKeyEnvPresent: Boolean(process.env.ANTHROPIC_API_KEY),
      email: oauth ? oauth.email : null,
      credentialFingerprint: oauth
        ? createHash('sha256').update(oauth.accessToken).digest('hex').slice(0, 12)
        : null
    }) + '\\n'
  )
}

let buffer = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\\n')
  while (index >= 0) {
    const command = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (command === 'exit') {
      process.exit(0)
    }
    const credentials = readCredentials()
    if (command === 'rotate') {
      // Never rewrite an unpinned surface: without a pinned config dir this
      // path is the developer's own ~/.claude.
      if (!process.env.CLAUDE_CONFIG_DIR) {
        process.exit(1)
      }
      if (credentials) {
        credentials.claudeAiOauth.accessToken += '-rotated'
        credentials.claudeAiOauth.refreshToken += '-rotated'
        writeFileSync(credentialsPath, JSON.stringify(credentials) + '\\n', 'utf-8')
      }
    }
    report(command === 'rotate' ? readCredentials() : credentials)
    index = buffer.indexOf('\\n')
  }
})
`

type FakeClaudeReport = {
  configDir: string
  securestorageConfigDir: string | null
  apiKeyEnvPresent: boolean
  email: string | null
  credentialFingerprint: string | null
}

type FakeClaude = {
  ask(command: 'report' | 'rotate'): Promise<FakeClaudeReport>
  stop(): Promise<void>
}

/** The same digest the child computes, so a test can name an expected token
 *  without either side printing one. */
function fingerprintOf(credentialsJson: string): string {
  const parsed = JSON.parse(credentialsJson) as { claudeAiOauth: { accessToken: string } }
  return createHash('sha256').update(parsed.claudeAiOauth.accessToken).digest('hex').slice(0, 12)
}

function startFakeClaude(scriptPath: string, env: Record<string, string>): FakeClaude {
  const child = spawn(process.execPath, [scriptPath], {
    // A home of its own: an unpinned fallback must land in the test's fake
    // home, never in the developer's real ~/.claude.
    env: {
      ...process.env,
      HOME: testState.fakeHomeDir,
      USERPROFILE: testState.fakeHomeDir,
      ...env
    },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  const waiters: { resolve: (line: string) => void; reject: (error: Error) => void }[] = []
  let buffer = ''
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      waiters.shift()?.resolve(line)
    }
  })
  // Why: without this a crashed fixture hangs the suite on an answer that will
  // never come, and the failure reads as a timeout instead of a dead child.
  child.on('exit', (code) => {
    while (waiters.length > 0) {
      waiters.shift()?.reject(new Error(`fake claude exited (${code}) before answering`))
    }
  })
  return {
    async ask(command) {
      const answer = new Promise<string>((resolve, reject) => waiters.push({ resolve, reject }))
      child.stdin.write(`${command}\n`)
      return JSON.parse(await answer) as FakeClaudeReport
    },
    async stop() {
      if (child.exitCode !== null) {
        return
      }
      child.stdin.write('exit\n')
      await once(child, 'close')
    }
  }
}

/**
 * End-to-end on the real filesystem, with the real profile Store and two real
 * child processes alive at the same time. Only the macOS Keychain and the
 * OAuth refresh endpoint are simulated — a test may not write the developer's
 * login keychain, and it may not call Anthropic. Everything else (the runtime
 * auth service, the account directories, the persisted live-PTY bindings, the
 * launched processes) is the production path.
 */
describe('Claude host account isolation smoke', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
  })

  it('keeps two live accounts, a rotation and a restart inside their own surfaces', async () => {
    const scriptPath = join(testState.userDataDir, 'fake-claude.cjs')
    writeFileSync(scriptPath, FAKE_CLAUDE_CLI, 'utf-8')
    const sharedCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    writeFileSync(sharedCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials

    const credentialsA = createClaudeCredentialsJson('a@example.com', 'a-token')
    const credentialsB = createClaudeCredentialsJson('b@example.com', 'b-token')
    const pathA = createManagedClaudeAuth(testState.userDataDir, 'account-a', credentialsA)
    const pathB = createManagedClaudeAuth(testState.userDataDir, 'account-b', credentialsB)

    installFakeAppEnvironment({ getPath: () => testState.userDataDir })
    initDataPath()
    const dataFile = join(testState.userDataDir, 'orca-data.json')
    const store = new Store({ dataFile })
    store.updateSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-a', pathA, { email: 'a@example.com' }),
        createClaudeAccount('account-b', pathB, { email: 'b@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-a'
    })

    // Dynamic imports on purpose: the restart below runs `vi.resetModules()`,
    // and only modules imported after it get the fresh gate/service state a
    // relaunched app would have. A static import would hand back the pre-
    // restart singletons and prove nothing about reconstruction.
    const { applyClaudeEnvPatch } = await import('./environment')
    const gate = await import('./live-pty-gate')
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    gate.attachClaudeLivePtyPersistence(store)
    const service = new ClaudeRuntimeAuthService(store)

    const preparationA = await service.prepareForClaudeLaunch()
    const envA = applyClaudeEnvPatch(
      // An ambient key would out-rank the managed credential; the launch strips it.
      { ANTHROPIC_API_KEY: 'ambient-key' },
      preparationA.envPatch,
      { stripAuthEnv: preparationA.stripAuthEnv, platform: process.platform }
    )
    gate.markClaudePtySpawned('pty-a', gate.claudeLivePtyBindingForPreparation(preparationA))
    const childA = startFakeClaude(scriptPath, envA)

    let childB: FakeClaude | null = null
    try {
      const reportA = await childA.ask('report')

      expect(reportA.configDir).toBe(pathA)
      expect(reportA.securestorageConfigDir).toBe(pathA)
      expect(reportA.email).toBe('a@example.com')
      expect(reportA.apiKeyEnvPresent).toBe(false)
      expect(reportA.credentialFingerprint).toBe(fingerprintOf(credentialsA))

      // Account B is selected and launched while A's process is still running.
      store.updateSettings({ activeClaudeManagedAccountId: 'account-b' })
      const preparationB = await service.prepareForClaudeLaunch()
      const envB = applyClaudeEnvPatch({}, preparationB.envPatch, {
        stripAuthEnv: preparationB.stripAuthEnv,
        platform: process.platform
      })
      gate.markClaudePtySpawned('pty-b', gate.claudeLivePtyBindingForPreparation(preparationB))
      childB = startFakeClaude(scriptPath, envB)
      const reportB = await childB.ask('report')

      expect(reportB.configDir).toBe(pathB)
      expect(reportB.email).toBe('b@example.com')
      expect(reportB.credentialFingerprint).toBe(fingerprintOf(credentialsB))
      // Selecting B did not move the surface A's live process reads.
      expect((await childA.ask('report')).credentialFingerprint).toBe(fingerprintOf(credentialsA))
      expect(readAccountRuntimeCredentials(pathA)).toBe(credentialsA)
      expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(systemCredentials)
      expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
      expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
      expect(testState.runtimeWriteConfigDir).toBeNull()

      // A's process refreshes its own token mid-session, as the real CLI does.
      const rotatedReportA = await childA.ask('rotate')
      const rotatedA = readAccountRuntimeCredentials(pathA)

      expect(rotatedA).not.toBe(credentialsA)
      expect(rotatedReportA.credentialFingerprint).toBe(fingerprintOf(rotatedA ?? ''))
      expect(rotatedA).toContain('a-token-rotated')
      // B's live process is untouched by A's write, byte for byte.
      expect(readAccountRuntimeCredentials(pathB)).toBe(credentialsB)
      expect((await childB.ask('report')).credentialFingerprint).toBe(fingerprintOf(credentialsB))

      // Re-selecting A reads that rotation back into A's managed storage only.
      store.updateSettings({ activeClaudeManagedAccountId: 'account-a' })
      await service.prepareForClaudeLaunch()

      expect(readManagedCredentialsForTest('account-a', pathA)).toBe(rotatedA)
      expect(readManagedCredentialsForTest('account-b', pathB)).toBe(credentialsB)
      expect(readAccountRuntimeCredentials(pathA)).toBe(rotatedA)
      // The rotation reached A's own dir-scoped Keychain item; B's is untouched.
      expect(readAccountKeychainCredentials(pathA)).toBe(rotatedA)
      expect(readAccountKeychainCredentials(pathB)).toBe(credentialsB)
      expect(existsSync(join(pathB, '.orca-managed-claude-auth'))).toBe(true)
      expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(systemCredentials)

      // ── Restart: both children survive it, the way daemon sessions do. ──
      store.flush()
      vi.resetModules()
      const reloaded = new Store({ dataFile })

      // The binding came off disk, not out of the previous process's memory.
      expect(reloaded.getClaudeLivePtyBindings()).toEqual([
        { sessionId: 'pty-a', route: 'account-dir', accountId: 'account-a' },
        { sessionId: 'pty-b', route: 'account-dir', accountId: 'account-b' }
      ])
      expect(reloaded.getSettings().activeClaudeManagedAccountId).toBe('account-a')

      const restartedGate = await import('./live-pty-gate')
      const oauth = await import('./oauth-refresh')
      restartedGate.attachClaudeLivePtyPersistence(reloaded)
      // Seeded before the service is constructed, as startup does: a service
      // built first would refresh A's token out from under its live process.
      restartedGate.seedLiveClaudePtysFromPersistence(
        reloaded.getClaudeLivePtySessionIds(),
        // The same mapping startup uses, so this seeds what a relaunched app
        // would seed — including its fail-closed handling of an unattributable row.
        Object.fromEntries(
          reloaded
            .getClaudeLivePtyBindings()
            .map((entry): [string, ClaudeLivePtyBinding] => [
              entry.sessionId,
              restartedGate.claudeLivePtyBindingForPersistedEntry(entry)
            ])
        )
      )
      const refreshedB = createClaudeCredentialsJson(
        'b@example.com',
        'b-token-refreshed',
        null,
        9_999_999_999_999
      )
      vi.mocked(oauth.isOauthTokenExpiring).mockReturnValue(true)
      vi.mocked(oauth.refreshClaudeOauthCredentials).mockResolvedValue(refreshedB)
      const restartedRuntimeAuth = await import('./runtime-auth-service')
      const restartedService = new restartedRuntimeAuth.ClaudeRuntimeAuthService(reloaded)

      const restartedA = await restartedService.prepareForRateLimitFetch()

      expect(restartedA.configDir).toBe(pathA)
      expect(restartedA.managedRefreshDeferredByLivePty).toBe(true)
      expect(oauth.refreshClaudeOauthCredentials).not.toHaveBeenCalled()
      // A's live process still reads exactly the bytes it rotated.
      expect(readAccountRuntimeCredentials(pathA)).toBe(rotatedA)
      expect((await childA.ask('report')).credentialFingerprint).toBe(fingerprintOf(rotatedA ?? ''))

      // B's session drains; the daemon no longer lists it, so its gate entry
      // and its persisted row go, while A's binding stays put.
      await childB.stop()
      restartedGate.confirmSeededClaudeLivePtys(['pty-a'])

      expect(restartedGate.hasLiveClaudePtysForAccount('account-a')).toBe(true)
      expect(restartedGate.hasLiveClaudePtysForAccount('account-b')).toBe(false)
      expect(reloaded.getClaudeLivePtyBindings()).toEqual([
        { sessionId: 'pty-a', route: 'account-dir', accountId: 'account-a' }
      ])

      reloaded.updateSettings({ activeClaudeManagedAccountId: 'account-b' })
      const restartedB = await restartedService.prepareForRateLimitFetch()

      // B refreshes because nothing holds its token — A stays frozen behind its
      // own live process, which is the per-account half of the gate.
      expect(restartedB.configDir).toBe(pathB)
      expect(restartedB.managedRefreshDeferredByLivePty).toBeFalsy()
      expect(oauth.refreshClaudeOauthCredentials).toHaveBeenCalledWith(credentialsB)
      expect(readAccountRuntimeCredentials(pathB)).toBe(refreshedB)
      expect(readAccountRuntimeCredentials(pathA)).toBe(rotatedA)
      expect((await childA.ask('report')).credentialFingerprint).toBe(fingerprintOf(rotatedA ?? ''))
      expect(readFileSync(sharedCredentialsPath, 'utf-8')).toBe(systemCredentials)
      expect(testState.runtimeWriteConfigDir).toBeNull()
    } finally {
      await childA.stop()
      await childB?.stop()
    }
  })
})
