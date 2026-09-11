import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeEnvPatch } from './environment'
import { isOrcaManagedClaudeAuthDir } from './managed-auth-path'

export type ClaudeRuntimePaths = {
  configDir: string
  credentialsPath: string
  configPath: string
  envPatch: ClaudeEnvPatch
}

export class ClaudeRuntimePathResolver {
  getRuntimePaths(): ClaudeRuntimePaths {
    const inheritedConfigDir = this.resolveInheritedSharedConfigDir()
    const configDir = inheritedConfigDir || join(homedir(), '.claude')
    mkdirSync(configDir, { recursive: true })

    return {
      configDir,
      credentialsPath: join(configDir, '.credentials.json'),
      configPath: this.resolveConfigPath(configDir, inheritedConfigDir),
      // Why: Claude Code 2.1.220+ derives the Keychain service name from
      // CLAUDE_SECURESTORAGE_CONFIG_DIR. Patching only CLAUDE_CONFIG_DIR would
      // let the CLI key its item on a differently inherited securestorage dir
      // while Orca reads and restores the one keyed on this dir.
      envPatch: inheritedConfigDir
        ? { CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir }
        : {}
    }
  }

  /**
   * The user's own surface may be redirected by an explicit ambient
   * CLAUDE_CONFIG_DIR — that is a supported setup and stays supported.
   *
   * It may not be redirected onto a MANAGED account's directory: that happens
   * when Orca is launched from inside an account-pinned pane (or any shell
   * that exported the var), and it would make the system-default snapshot
   * capture and restore read and overwrite that account's credentials as if
   * they were the user's own. An account dir is never the shared surface, so
   * fall back to ~/.claude.
   */
  private resolveInheritedSharedConfigDir(): string | null {
    const inheritedConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || null
    if (!inheritedConfigDir || !isOrcaManagedClaudeAuthDir(inheritedConfigDir)) {
      return inheritedConfigDir
    }
    console.warn(
      '[claude-runtime-auth] Ignoring inherited CLAUDE_CONFIG_DIR that points at a managed account directory; using the home Claude directory as the shared surface'
    )
    return null
  }

  /**
   * The same shape for a host managed account's own config dir.
   *
   * Deliberately ignores an inherited CLAUDE_CONFIG_DIR: a pinned account is
   * the launch's config dir, so a nested Orca's ambient value must not redirect
   * one account's credentials onto another surface.
   */
  getAccountRuntimePaths(configDir: string): ClaudeRuntimePaths {
    mkdirSync(configDir, { recursive: true })
    return {
      configDir,
      credentialsPath: join(configDir, '.credentials.json'),
      configPath: join(configDir, '.claude.json'),
      envPatch: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir }
    }
  }

  private resolveConfigPath(configDir: string, inheritedConfigDir: string | null): string {
    const colocatedConfigPath = join(configDir, '.claude.json')
    if (inheritedConfigDir || existsSync(colocatedConfigPath)) {
      return colocatedConfigPath
    }
    return join(homedir(), '.claude.json')
  }
}
