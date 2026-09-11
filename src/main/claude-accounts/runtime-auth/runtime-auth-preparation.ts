import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import { resolveLocalAccountRuntimeTarget } from '../../../shared/local-account-runtime'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { shouldStripClaudeAuthEnvForAccount } from '../environment'
import { syncSystemClaudeResourcesIntoAccountConfigDir } from '../account-config-dir-resources'
import { resolveOwnedClaudeManagedAuthPath } from '../managed-auth-path'
import { getDefaultWslDistro, getWslHome } from '../../wsl'
import {
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from '../runtime-selection'
import { ClaudeRuntimeAuthSnapshotRestore } from './runtime-auth-snapshot-restore'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth-types'

export class ClaudeRuntimeAuthPreparationService extends ClaudeRuntimeAuthSnapshotRestore {
  protected getPreparation(target?: ClaudeAccountSelectionTarget): ClaudeRuntimeAuthPreparation {
    const settings = this.store.getSettings()
    const paths = this.pathResolver.getRuntimePaths()
    const normalizedTarget = this.resolveWslDefaultTarget(
      target ?? this.getDefaultAccountSelectionTarget(settings)
    )
    const activeAccountId = getSelectedClaudeAccountIdForTarget(settings, normalizedTarget)
    const activeAccount = this.getActiveAccount(settings.claudeManagedAccounts, activeAccountId)
    if (
      normalizeClaudeAccountSelectionTarget(normalizedTarget).runtime === 'wsl' &&
      activeAccount?.managedAuthRuntime === 'wsl' &&
      activeAccount.wslLinuxAuthPath
    ) {
      return {
        configDir: activeAccount.managedAuthPath,
        runtime: 'wsl',
        wslDistro: activeAccount.wslDistro ?? null,
        wslLinuxConfigDir: activeAccount.wslLinuxAuthPath,
        envPatch: { CLAUDE_CONFIG_DIR: activeAccount.wslLinuxAuthPath },
        stripAuthEnv: true,
        accountId: activeAccount.id,
        configDirRoute: 'wsl-dir',
        provenance: `managed:${activeAccount.id}:wsl:${activeAccount.wslDistro ?? ''}`
      }
    }
    if (normalizeClaudeAccountSelectionTarget(normalizedTarget).runtime === 'wsl') {
      const distro =
        normalizeClaudeAccountSelectionTarget(normalizedTarget).wslDistro ?? getDefaultWslDistro()
      const wslHome = distro ? getWslHome(distro) : null
      const wslHomeInfo = wslHome ? parseWslUncPath(wslHome) : null
      if (distro && wslHome && wslHomeInfo) {
        const windowsConfigDir = join(wslHome, '.claude')
        const linuxConfigDir = `${wslHomeInfo.linuxPath.replace(/\/$/, '')}/.claude`
        return {
          configDir: windowsConfigDir,
          runtime: 'wsl',
          wslDistro: distro,
          wslLinuxConfigDir: linuxConfigDir,
          envPatch: {},
          stripAuthEnv: true,
          accountId: null,
          configDirRoute: 'shared-dir',
          provenance: `wsl:${distro}:system`
        }
      }
      return {
        configDir: paths.configDir,
        runtime: 'wsl',
        wslDistro: normalizeClaudeAccountSelectionTarget(normalizedTarget).wslDistro,
        wslLinuxConfigDir: null,
        envPatch: {},
        stripAuthEnv: true,
        accountId: null,
        configDirRoute: 'shared-dir',
        provenance: `wsl:${normalizeClaudeAccountSelectionTarget(normalizedTarget).wslDistro ?? '__default__'}:system`
      }
    }
    const hostAccountConfigDir =
      activeAccount && activeAccount.managedAuthRuntime !== 'wsl'
        ? // Why: sync() has already refused a selection whose directory Orca
          // cannot prove it owns, but getPreparation is also reached directly
          // (getRuntimeConfigDir). Re-resolving here means an unowned path can
          // never be handed to a launch as a config dir.
          resolveOwnedClaudeManagedAuthPath(activeAccount.id, activeAccount.managedAuthPath)
        : null
    if (activeAccount && hostAccountConfigDir) {
      const legacySharedGrantBlocked = this.legacySharedGrantBlockedAccountId === activeAccount.id
      // Why: every managed account gets its own CLAUDE_CONFIG_DIR, the way WSL
      // managed accounts already do. Two accounts then have two credential
      // surfaces and two scoped Keychain items, so selecting one cannot rewrite
      // the other's tokens or the user's own ~/.claude.
      if (!legacySharedGrantBlocked) {
        syncSystemClaudeResourcesIntoAccountConfigDir(hostAccountConfigDir)
      }
      return {
        configDir: hostAccountConfigDir,
        runtime: 'host',
        wslDistro: null,
        wslLinuxConfigDir: null,
        envPatch: {
          CLAUDE_CONFIG_DIR: hostAccountConfigDir,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: hostAccountConfigDir
        },
        stripAuthEnv: true,
        // Why: nothing was materialized into this dir yet, so a quota read here
        // must report "waiting on a live session", not an auth failure.
        managedRefreshDeferredByLivePty:
          legacySharedGrantBlocked ||
          this.managedRefreshDeferredByLivePtyAccountId === activeAccount.id,
        legacySharedGrantBlocked,
        accountId: activeAccount.id,
        configDirRoute: 'account-dir',
        provenance: `managed:${activeAccount.id}`
      }
    }
    return {
      configDir: paths.configDir,
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: paths.envPatch,
      stripAuthEnv: shouldStripClaudeAuthEnvForAccount(
        settings.claudeManagedAccounts,
        activeAccountId
      ),
      accountId: null,
      configDirRoute: 'shared-dir',
      provenance: 'system'
    }
  }

  protected getActiveAccount(
    accounts: ClaudeManagedAccount[],
    activeAccountId: string | null
  ): ClaudeManagedAccount | null {
    if (!activeAccountId) {
      return null
    }
    return accounts.find((account) => account.id === activeAccountId) ?? null
  }

  protected getDefaultAccountSelectionTarget(
    settings = this.store.getSettings()
  ): ClaudeAccountSelectionTarget {
    // Why: Windows auth follows the resolved account runtime; stale cross-platform WSL pins must stay local-host.
    const resolved = resolveLocalAccountRuntimeTarget(settings)
    if (process.platform === 'win32' && resolved.runtime === 'wsl') {
      return { runtime: 'wsl', wslDistro: resolved.wslDistro }
    }
    return { runtime: 'host' }
  }

  protected resolveWslDefaultTarget(
    target?: ClaudeAccountSelectionTarget
  ): ClaudeAccountSelectionTarget {
    if (target?.runtime !== 'wsl' || target.wslDistro?.trim()) {
      return target ?? { runtime: 'host' }
    }
    const defaultDistro = getDefaultWslDistro()
    return defaultDistro ? { runtime: 'wsl', wslDistro: defaultDistro } : target
  }
}
