import type { Store } from '../persistence'
import { resolve } from 'node:path'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { CLAUDE_LEGACY_SESSION_MIGRATION_MESSAGE } from './environment'
import { resolveOwnedClaudeManagedAuthPath } from './managed-auth-path'
import { ClaudeRuntimeAuthSync } from './runtime-auth/runtime-auth-sync'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export class ClaudeRuntimeAuthService extends ClaudeRuntimeAuthSync {
  constructor(store: Store) {
    super(store)
    this.initializeLastSyncedState()
    void this.safeSyncForCurrentSelection()
  }

  async prepareForClaudeLaunch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    await this.syncForCurrentSelection(effectiveTarget)
    const preparation = this.getPreparation(effectiveTarget)
    if (preparation.legacySharedGrantBlocked) {
      // Why: launching anyway would put two CLIs on one single-use refresh
      // token — the first rotation logs the other out. Refusing is recoverable;
      // the user closes the old session (or restarts Orca) and launches again.
      throw new Error(CLAUDE_LEGACY_SESSION_MIGRATION_MESSAGE)
    }
    return preparation
  }

  /**
   * The launch preparation for a config dir that is already fixed — a
   * structured Claude session re-acquired under the account it was created
   * with, which may not be the account selected right now.
   *
   * Why not `prepareForClaudeLaunch`: that one materializes and describes the
   * SELECTION. Binding a child that launches on account A's dir to account B
   * because B happens to be selected mis-attributes the refresh gate, and A's
   * single-use refresh token then gets rotated while that child holds it.
   * Anything this cannot attribute to an owned surface is refused rather than
   * silently run against the user's own ~/.claude.
   */
  async prepareForClaudeLaunchOnConfigDir(
    configDir: string
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const settings = this.store.getSettings()
    const owner = settings.claudeManagedAccounts
      .filter((account) => account.managedAuthRuntime !== 'wsl')
      .map((account) => ({
        account,
        ownedConfigDir: resolveOwnedClaudeManagedAuthPath(account.id, configDir)
      }))
      .find((candidate) => candidate.ownedConfigDir !== null)
    if (!owner?.ownedConfigDir) {
      if (resolve(configDir) !== resolve(this.pathResolver.getRuntimePaths().configDir)) {
        throw new Error(
          'Claude session config directory is neither a managed account directory nor the shared Claude directory.'
        )
      }
      // Why: sync the selection (and inherit its legacy-grant refusal) but
      // describe the surface this child actually launches on. After the sync a
      // selected account has materialized into its OWN dir and any legacy
      // grant still sitting on the shared one has already thrown, so ~/.claude
      // is the user's — reporting the selected account's dir here would bind
      // this child's refresh gate to an account it never touches.
      await this.prepareForClaudeLaunch({ runtime: 'host' })
      const paths = this.pathResolver.getRuntimePaths()
      return {
        configDir: paths.configDir,
        runtime: 'host',
        wslDistro: null,
        wslLinuxConfigDir: null,
        envPatch: paths.envPatch,
        // Why: no managed account owns this launch's credential, so the user's
        // own inherited ANTHROPIC_* is their sign-in and must survive.
        stripAuthEnv: false,
        accountId: null,
        configDirRoute: 'shared-dir',
        provenance: 'system'
      }
    }
    const { account: ownedAccount, ownedConfigDir: accountConfigDir } = owner
    if (ownedAccount.id === getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })) {
      return this.prepareForClaudeLaunch({ runtime: 'host' })
    }
    await this.serializeMutation(() =>
      this.materializeOwnedAccountForLaunch(ownedAccount, accountConfigDir)
    )
    return {
      configDir: accountConfigDir,
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: {
        CLAUDE_CONFIG_DIR: accountConfigDir,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: accountConfigDir
      },
      stripAuthEnv: true,
      accountId: ownedAccount.id,
      configDirRoute: 'account-dir',
      provenance: `managed:${ownedAccount.id}`
    }
  }

  async prepareForRateLimitFetch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  async syncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    await this.serializeMutation(() =>
      this.doSyncForCurrentSelection(target ?? this.getDefaultAccountSelectionTarget())
    )
  }

  async forceMaterializeCurrentSelectionForRollback(): Promise<void> {
    await this.serializeMutation(async () => {
      // Why: this entry point runs after a failed account switch, whose sync
      // may have thrown while pinned to the outgoing account's dir. The
      // shared-surface restore below must operate on the user's own ~/.claude,
      // never on that account's surface.
      this.pinnedAccountConfigDir = null
      const settings = this.store.getSettings()
      if (!settings.activeClaudeManagedAccountId) {
        const previousAccount = this.getActiveAccount(
          settings.claudeManagedAccounts,
          this.lastSyncedAccountId
        )
        await this.restoreSystemDefaultSnapshot(
          previousAccount ? await this.readManagedCredentials(previousAccount) : null,
          previousAccount ? await this.readManagedOauthAccount(previousAccount) : undefined
        )
        this.lastSyncedAccountId = null
        return
      }
      await this.doSyncForCurrentSelection()
    })
  }

  getRuntimeConfigDir(target?: ClaudeAccountSelectionTarget): string {
    return this.getPreparation(target).configDir
  }

  private initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    this.lastSyncedAccountId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
  }

  private async safeSyncForCurrentSelection(): Promise<void> {
    try {
      await this.syncForCurrentSelection()
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to sync runtime auth state:', error)
    }
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  // Why: re-auth/add-account write fresh managed tokens; skip the next read-back so stale runtime tokens can't overwrite them.
  clearLastWrittenCredentialsJson(
    accountId = this.store.getSettings().activeClaudeManagedAccountId
  ): void {
    if (accountId === this.store.getSettings().activeClaudeManagedAccountId) {
      this.lastWrittenCredentialsJson = null
    }
    this.skipNextReadBackForAccountId = accountId
  }
}
