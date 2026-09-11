import {
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  normalizeClaudeRuntimeSelection,
  setSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from '../runtime-selection'
import { isOauthTokenExpiring } from '../oauth-refresh'
import { syncSystemClaudeResourcesIntoAccountConfigDir } from '../account-config-dir-resources'
import { ClaudeRuntimeAuthLegacySurface } from './runtime-auth-legacy-surface'

export class ClaudeRuntimeAuthSync extends ClaudeRuntimeAuthLegacySurface {
  /**
   * Materializes the current selection, with the account pin scoped to exactly
   * this call.
   *
   * Why the finally: the pin redirects every runtime read/write onto an
   * account's own dir. A sync that throws past the point where it pinned
   * (a credentials write EPERM, an oauth/managed read failure) — or one that
   * simply completes — used to leave it set, and the next SHARED-surface
   * operation (the rollback restore, a deselect) would then run against the
   * account's dir and overwrite its credentials with the user's own snapshot.
   */
  protected async doSyncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    try {
      await this.runSyncForCurrentSelection(target)
    } finally {
      this.pinnedAccountConfigDir = null
    }
  }

  private async runSyncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    const settings = this.store.getSettings()
    const effectiveTarget = this.resolveWslDefaultTarget(target)
    const normalizedTarget = normalizeClaudeAccountSelectionTarget(effectiveTarget)
    const activeAccountId = getSelectedClaudeAccountIdForTarget(settings, normalizedTarget)
    const activeAccount = this.getActiveAccount(settings.claudeManagedAccounts, activeAccountId)
    const previousAccount = this.getActiveAccount(
      settings.claudeManagedAccounts,
      this.lastSyncedAccountId
    )
    this.managedRefreshDeferredByLivePtyAccountId = null
    this.legacySharedGrantBlockedAccountId = null
    this.pinnedAccountConfigDir = null
    const previousManagedCredentialsJson = previousAccount
      ? await this.readManagedCredentials(previousAccount)
      : null
    const previousManagedOauthAccount = previousAccount
      ? await this.readManagedOauthAccount(previousAccount)
      : null
    if (previousAccount && previousAccount.id !== activeAccount?.id) {
      if (previousManagedCredentialsJson) {
        // Why: the outgoing account's refreshes live on ITS surface — its own
        // config dir once isolated, the shared one for a selection that never
        // migrated. Reading the wrong surface would either miss the rotation
        // or attribute someone else's to this account.
        this.pinnedAccountConfigDir =
          previousAccount.managedAuthRuntime === 'wsl'
            ? null
            : await this.getOwnedManagedAuthPath(previousAccount)
        const outgoingReadBackResult = await this.readBackRefreshedTokens(
          previousManagedCredentialsJson,
          {
            updateLastWrittenCredentialsJson: true
          }
        )
        if (
          outgoingReadBackResult.status === 'rejected' &&
          outgoingReadBackResult.runtimeCredentialsChanged &&
          this.hasLiveClaudeOwnerForActiveSurface(previousAccount.id)
        ) {
          if (
            outgoingReadBackResult.runtimeCredentialsJson &&
            this.liveRuntimeCredentialsCanUpdateActiveAccount(
              outgoingReadBackResult.runtimeCredentialsJson,
              previousAccount,
              previousManagedCredentialsJson,
              previousManagedOauthAccount
            )
          ) {
            // Why: switching away while Claude is live must preserve verified token refreshes before replacing shared runtime credentials.
            await this.writeManagedCredentials(
              previousAccount,
              outgoingReadBackResult.runtimeCredentialsJson
            )
          } else {
            // Why: the runtime blob may lack identity proof for a live-session refresh; skip persisting it, but still let new terminals move to the account.
            console.warn(
              '[claude-runtime-auth] Skipping unverified live Claude auth read-back while switching accounts'
            )
          }
        }
      }
      this.pinnedAccountConfigDir = null
    }
    if (!activeAccount) {
      if (activeAccountId) {
        const nextSelection = setSelectedClaudeAccountIdForTarget(
          normalizeClaudeRuntimeSelection(settings),
          null,
          normalizedTarget
        )
        this.store.updateSettings({
          activeClaudeManagedAccountId:
            normalizedTarget.runtime === 'host' ? null : settings.activeClaudeManagedAccountId,
          activeClaudeManagedAccountIdsByRuntime: nextSelection
        })
      }
      if (normalizedTarget.runtime === 'wsl') {
        return
      }
      if (this.lastSyncedAccountId !== null) {
        await (previousAccount
          ? this.restoreSystemDefaultSnapshot(
              previousManagedCredentialsJson,
              previousManagedOauthAccount
            )
          : this.restoreSystemDefaultSnapshot(this.lastWrittenCredentialsJson, undefined))
        this.lastSyncedAccountId = null
      }
      return
    }

    if (activeAccount.managedAuthRuntime === 'wsl') {
      if (!(await this.getOwnedManagedAuthPath(activeAccount))) {
        console.warn(
          '[claude-runtime-auth] Active WSL managed account is not owned by Orca, restoring system default'
        )
        const nextSelection = setSelectedClaudeAccountIdForTarget(
          normalizeClaudeRuntimeSelection(settings),
          null,
          normalizedTarget
        )
        this.store.updateSettings({
          activeClaudeManagedAccountId:
            normalizedTarget.runtime === 'host' ? null : settings.activeClaudeManagedAccountId,
          activeClaudeManagedAccountIdsByRuntime: nextSelection
        })
        return
      }
      const credentialsJson = await this.readManagedCredentials(activeAccount)
      if (!credentialsJson || !this.isValidCredentialsJsonObject(credentialsJson)) {
        console.warn(
          '[claude-runtime-auth] Active WSL managed account is missing or has invalid credentials, restoring system default'
        )
        const nextSelection = setSelectedClaudeAccountIdForTarget(
          normalizeClaudeRuntimeSelection(settings),
          null,
          normalizedTarget
        )
        this.store.updateSettings({
          activeClaudeManagedAccountId:
            normalizedTarget.runtime === 'host' ? null : settings.activeClaudeManagedAccountId,
          activeClaudeManagedAccountIdsByRuntime: nextSelection
        })
        return
      }
      // Why: WSL managed accounts are isolated by their Linux CLAUDE_CONFIG_DIR; materializing into Windows ~/.claude would mix two auth stores.
      this.clearLastWrittenRuntimeState()
      return
    }

    const accountConfigDir = await this.getOwnedManagedAuthPath(activeAccount)
    if (!accountConfigDir) {
      console.warn(
        '[claude-runtime-auth] Active managed account is not owned by Orca, restoring system default'
      )
      if (this.lastSyncedAccountId !== null) {
        if (
          previousAccount &&
          (previousAccount.id !== activeAccount.id ||
            this.hasMaterializedRuntimeAuth ||
            this.runtimeOauthAccountMatches(await this.readManagedOauthAccount(previousAccount)))
        ) {
          await this.restoreSystemDefaultSnapshotForMissingManagedCredentials(
            previousAccount,
            previousManagedOauthAccount
          )
        } else if (!previousAccount && this.hasMaterializedRuntimeAuth) {
          await this.restoreSystemDefaultSnapshot(this.lastWrittenCredentialsJson, undefined)
        }
      }
      this.store.updateSettings({ activeClaudeManagedAccountId: null })
      this.lastSyncedAccountId = null
      return
    }

    let credentialsJson = await this.readManagedCredentials(activeAccount)
    if (!credentialsJson || !this.isValidCredentialsJsonObject(credentialsJson)) {
      console.warn(
        '[claude-runtime-auth] Active managed account is missing or has invalid credentials, restoring system default'
      )
      if (this.lastSyncedAccountId !== null) {
        if (
          previousAccount &&
          (previousAccount.id !== activeAccount.id ||
            this.hasMaterializedRuntimeAuth ||
            this.runtimeOauthAccountMatches(previousManagedOauthAccount))
        ) {
          await this.restoreSystemDefaultSnapshotForMissingManagedCredentials(
            previousAccount,
            previousManagedOauthAccount
          )
        } else if (!previousAccount && this.hasMaterializedRuntimeAuth) {
          await this.restoreSystemDefaultSnapshot(this.lastWrittenCredentialsJson, undefined)
        }
      }
      this.store.updateSettings({ activeClaudeManagedAccountId: null })
      this.lastSyncedAccountId = null
      return
    }

    // Why: the grant this account holds may still be owned by a Claude started
    // before per-account isolation, which reads the shared ~/.claude. Copying
    // the same single-use refresh token into the account's own dir and letting
    // a second CLI rotate it would invalidate one of the two copies, so this
    // account stays un-materialized until that session drains. Only this
    // account is affected: accounts whose grant is not the one on the shared
    // surface are already isolated and keep working.
    if (await this.isLegacySharedGrantStillOwned(credentialsJson)) {
      console.warn(
        `[claude-runtime-auth] Deferring isolation of Claude account ${activeAccount.id}: a pre-isolation Claude session still owns its credentials`
      )
      this.legacySharedGrantBlockedAccountId = activeAccount.id
      return
    }

    // Why: a build before this one materialized managed credentials straight
    // into ~/.claude. Now that the account owns its own surface, hand the user
    // their own credentials back — but only once nothing is still reading the
    // shared one, and only if what is there is still the bytes Orca put there
    // (an external `claude login` since then owns that file, not us).
    await this.releaseLegacySharedSurface(activeAccount, credentialsJson)

    this.pinnedAccountConfigDir = accountConfigDir
    syncSystemClaudeResourcesIntoAccountConfigDir(accountConfigDir)

    // Why: the CLI writes refreshed tokens to .credentials.json. That file now
    // lives in the account's OWN dir, which stays this account's surface even
    // while another account is selected — so a rotation it performed in the
    // meantime (or while Orca was closed) must be preserved before
    // materializing managed storage over it, not only when this account was
    // also the last one synced.
    if (this.lastSyncedAccountId !== activeAccount.id) {
      // Why: nothing this process wrote describes the incoming account's dir,
      // so judge what is there as a cold start — adopted only with proof the
      // runtime blob is newer than managed storage.
      this.clearLastWrittenRuntimeState()
    }
    if (this.skipNextReadBackForAccountId === activeAccount.id) {
      this.skipNextReadBackForAccountId = null
    } else {
      const readBackResult = await this.readBackRefreshedTokens(credentialsJson, {
        updateLastWrittenCredentialsJson: true
      })
      if (readBackResult.status === 'persisted') {
        const updatedCredentialsJson = await this.readManagedCredentials(activeAccount)
        if (updatedCredentialsJson && this.isValidCredentialsJsonObject(updatedCredentialsJson)) {
          credentialsJson = updatedCredentialsJson
        }
      } else if (
        readBackResult.status === 'rejected' &&
        readBackResult.runtimeCredentialsChanged &&
        // Why: a live Claude that lost a refresh race can wipe its runtime blob (empty tokens); preserving that would log out every new session.
        readBackResult.hasValidChangedRuntimeCredentials &&
        this.hasLiveClaudeOwnerForActiveSurface(activeAccount.id)
      ) {
        if (
          readBackResult.runtimeCredentialsJson &&
          this.liveRuntimeCredentialsCanUpdateActiveAccount(
            readBackResult.runtimeCredentialsJson,
            activeAccount,
            credentialsJson,
            await this.readManagedOauthAccount(activeAccount)
          )
        ) {
          // Why: this Claude launched under the active managed account, but persistence still needs positive account proof.
          await this.writeManagedCredentials(activeAccount, readBackResult.runtimeCredentialsJson)
          credentialsJson = readBackResult.runtimeCredentialsJson
        } else {
          // Why: while Claude runs, an unknown refresh may belong to a live session; rewriting stale managed auth logs it out.
          console.warn(
            '[claude-runtime-auth] Preserving changed Claude runtime credentials while live Claude terminals are running'
          )
          this.lastSyncedAccountId = activeAccount.id
          this.hasMaterializedRuntimeAuth = true
          return
        }
      }
    }

    if (this.lastSyncedAccountId !== activeAccount.id) {
      this.skipNextReadBackForAccountId = null
    }

    // Why: rotate+persist the single-use token to managed storage before materializing (else runtime gets a stale token that fails invalid_grant); skip while a live Claude owns THIS account's credentials since refreshing would double-rotate it (invalidating one copy) — read-back preserves its refresh instead.
    const liveClaudeOwnsThisAccount = this.hasLiveClaudeOwnerForActiveSurface(activeAccount.id)
    if (liveClaudeOwnsThisAccount && isOauthTokenExpiring(credentialsJson)) {
      this.managedRefreshDeferredByLivePtyAccountId = activeAccount.id
    }
    if (!liveClaudeOwnsThisAccount) {
      const refreshed = await this.refreshManagedAccountTokenIfNeeded(
        activeAccount,
        credentialsJson
      )
      if (refreshed) {
        credentialsJson = refreshed
      }
    }

    this.writeRuntimeCredentials(credentialsJson)
    if (process.platform === 'darwin') {
      try {
        await this.writeActiveRuntimeKeychainCredentials(credentialsJson)
      } catch (error) {
        if (this.pinnedAccountConfigDir) {
          // Why: the account's own Keychain item is the only surface this
          // launch may use. Falling back to the system default here would run
          // the pane as whoever owns ~/.claude, so refuse instead — the shared
          // surface is untouched and needs no restore. doSyncForCurrentSelection's
          // finally drops the pin on the way out.
          throw error
        }
        await this.restoreSystemDefaultSnapshot(
          credentialsJson,
          await this.readManagedOauthAccount(activeAccount)
        )
        throw error
      }
    }
    const managedOauthAccount = await this.readManagedOauthAccount(activeAccount)
    if (this.writeRuntimeOauthAccount(managedOauthAccount)) {
      this.lastWrittenOauthAccount = managedOauthAccount
      this.hasLastWrittenOauthAccount = true
    } else {
      this.lastWrittenOauthAccount = null
      this.hasLastWrittenOauthAccount = false
    }
    this.lastSyncedAccountId = activeAccount.id
    this.hasMaterializedRuntimeAuth = true
  }
}
