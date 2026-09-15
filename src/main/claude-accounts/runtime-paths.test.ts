import {
  cleanupRuntimeAuthTestState,
  createElectronMock,
  createManagedClaudeAuth,
  expectedRuntimeConfigDir,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => createElectronMock())

// Why: the "resolving creates nothing" invariant needs a spy over the real
// implementation, so every other fs call still hits the temp dirs.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('ClaudeRuntimePathResolver shared surface', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    resetRuntimeAuthTestState()
    delete process.env.CLAUDE_CONFIG_DIR
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
  })

  it('honours an explicit inherited config dir and keys securestorage on it', async () => {
    const inheritedConfigDir = join(testState.fakeHomeDir, 'custom-claude')
    process.env.CLAUDE_CONFIG_DIR = inheritedConfigDir

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configDir).toBe(inheritedConfigDir)
    // Why: Claude Code 2.1.220+ derives the Keychain service name from this
    // var, so patching only CLAUDE_CONFIG_DIR leaves the CLI reading an item
    // Orca never wrote.
    expect(paths.envPatch).toEqual({
      CLAUDE_CONFIG_DIR: inheritedConfigDir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: inheritedConfigDir
    })
  })

  it('refuses to treat a managed account directory as the user own surface', async () => {
    const managedAuthPath = createManagedClaudeAuth(testState.userDataDir, 'account-1', '{}\n')
    // A nested Orca launched from inside an account-pinned pane inherits this.
    process.env.CLAUDE_CONFIG_DIR = managedAuthPath
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    // Why: the system-default snapshot capture and restore read and write this
    // dir. Following the pin here would make them operate on the account's
    // credentials as if they were the user's own.
    expect(paths.configDir).toBe(join(testState.fakeHomeDir, '.claude'))
    expect(paths.credentialsPath).toBe(join(testState.fakeHomeDir, '.claude', '.credentials.json'))
    expect(paths.envPatch).toEqual({})
    warn.mockRestore()
  })

  it('keeps an inherited dir that merely carries a marker file', async () => {
    // Why: the marker only names a candidate owner. Ownership is decided by
    // the managed-accounts root and the account's own directory shape, so a
    // hand-written marker in the user's custom dir must not silently redirect
    // their explicit CLAUDE_CONFIG_DIR back to ~/.claude.
    const inheritedConfigDir = join(testState.fakeHomeDir, 'custom-claude')
    mkdirSync(inheritedConfigDir, { recursive: true })
    writeFileSync(join(inheritedConfigDir, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    process.env.CLAUDE_CONFIG_DIR = inheritedConfigDir

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configDir).toBe(inheritedConfigDir)
  })

  it('never lets an inherited dir redirect an account surface', async () => {
    const managedAuthPath = createManagedClaudeAuth(testState.userDataDir, 'account-1', '{}\n')
    process.env.CLAUDE_CONFIG_DIR = join(testState.fakeHomeDir, 'custom-claude')

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getAccountRuntimePaths(managedAuthPath)

    expect(paths.configDir).toBe(managedAuthPath)
    expect(paths.envPatch).toEqual({
      CLAUDE_CONFIG_DIR: managedAuthPath,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: managedAuthPath
    })
  })
})

describe('ClaudeRuntimePathResolver resolution side effects', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    resetRuntimeAuthTestState()
    delete process.env.CLAUDE_CONFIG_DIR
    // Why: the harness seeds a populated home; these cases are about what
    // resolving does to a home that has no Claude directory yet.
    rmSync(expectedRuntimeConfigDir(), { recursive: true, force: true })
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
  })

  it.each([false, true])(
    'does no mkdir work for repeated reads (directory exists: %s)',
    async (exists) => {
      if (exists) {
        mkdirSync(expectedRuntimeConfigDir(), { recursive: true })
      }
      const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
      // Why: the harness resets the module registry per test, so the resolver
      // holds a fresh `node:fs` instance — asserting on this file's own import
      // would watch a spy nothing calls and pass no matter what.
      const { mkdirSync: resolverMkdirSync } = await import('node:fs')
      vi.mocked(resolverMkdirSync).mockClear()
      const resolver = new ClaudeRuntimePathResolver()

      for (let index = 0; index < 1000; index += 1) {
        resolver.getRuntimePaths()
      }

      expect(resolverMkdirSync).not.toHaveBeenCalled()
    }
  )

  it('leaves the default config directory alone while resolving paths', async () => {
    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configDir).toBe(expectedRuntimeConfigDir())
    // Why: background rate-limit refreshes resolve these paths even when Claude
    // is disabled, so resolving must never materialize the directory (#12181).
    expect(existsSync(paths.configDir)).toBe(false)
  })

  it('leaves an inherited CLAUDE_CONFIG_DIR alone while resolving paths', async () => {
    const inherited = join(testState.fakeHomeDir, 'inherited-claude')
    process.env.CLAUDE_CONFIG_DIR = inherited

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configDir).toBe(inherited)
    expect(existsSync(inherited)).toBe(false)
  })

  it('falls back to the home config file when no colocated config exists', async () => {
    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configPath).toBe(join(testState.fakeHomeDir, '.claude.json'))
    expect(paths.envPatch).toEqual({})
  })

  it('prefers a colocated config file once it exists', async () => {
    const configDir = expectedRuntimeConfigDir()
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, '.claude.json'), '{}')

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configPath).toBe(join(configDir, '.claude.json'))
  })

  it('keeps the inherited config file colocated even before it exists', async () => {
    const inherited = join(testState.fakeHomeDir, 'inherited-claude')
    process.env.CLAUDE_CONFIG_DIR = inherited

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configPath).toBe(join(inherited, '.claude.json'))
  })
})
