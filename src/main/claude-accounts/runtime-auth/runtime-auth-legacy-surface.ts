import { existsSync, readFileSync } from 'node:fs'
import { hasLiveClaudePtysForAccount, hasLiveClaudeSessionsOnSharedSurface } from '../live-pty-gate'
import { CLAUDE_LEGACY_SESSION_MIGRATION_MESSAGE } from '../environment'
import { syncSystemClaudeResourcesIntoAccountConfigDir } from '../account-config-dir-resources'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import { ClaudeRuntimeAuthPreparationService } from './runtime-auth-preparation'

/**
 * The surfaces a sync has to reason about besides the one it materializes:
 * the user's own ~/.claude carrying a grant from before per-account isolation,
 * and an owned account dir that the CURRENT selection does not point at.
 *
 * Split out of the sync itself because none of it depends on the selection
 * walk — it answers "who owns this grant right now" and undoes or performs a
 * materialization on a surface the walk is not currently pinned to.
 */
export class ClaudeRuntimeAuthLegacySurface extends ClaudeRuntimeAuthPreparationService {
  /**
   * Materializes an owned host managed account into ITS OWN config dir without
   * touching the current selection.
   *
   * Why: a structured Claude session's config dir is fixed when the session is
   * created, so re-acquiring that session while a different account is
   * selected must launch on the ORIGINAL account's credentials. The selection,
   * `lastSyncedAccountId`, the shared surface and the selection's own
   * last-write bookkeeping are all left exactly as they were — this is a
   * launch-time materialization, not a switch.
   */
  protected async materializeOwnedAccountForLaunch(
    account: ClaudeManagedAccount,
    accountConfigDir: string
  ): Promise<void> {
    let credentialsJson = await this.readManagedCredentials(account)
    if (!credentialsJson || !this.isValidCredentialsJsonObject(credentialsJson)) {
      throw new Error(`Claude managed account ${account.id} has no usable stored credentials.`)
    }
    // Why: the same refusal the terminal preflight makes — a Claude started
    // before per-account isolation still holding this grant on the shared
    // surface means two CLIs would rotate one single-use refresh token.
    if (await this.isLegacySharedGrantStillOwned(credentialsJson)) {
      throw new Error(CLAUDE_LEGACY_SESSION_MIGRATION_MESSAGE)
    }
    const selectionRuntimeState = this.captureLastWrittenRuntimeState()
    this.pinnedAccountConfigDir = accountConfigDir
    try {
      syncSystemClaudeResourcesIntoAccountConfigDir(accountConfigDir)
      // Why: nothing this process wrote describes this dir from the selection's
      // point of view, so judge what sits there as a cold start — adopted only
      // with proof the runtime blob is newer than managed storage.
      this.clearLastWrittenRuntimeState()
      // Why: the same rule the selection sync applies — a re-auth just wrote
      // fresh tokens to managed storage while this dir still holds the
      // pre-re-auth blob, and a cold-start read-back would adopt that blob
      // (rotated refresh token, no comparable expiry) and undo the re-auth.
      if (this.skipNextReadBackForAccountId === account.id) {
        this.skipNextReadBackForAccountId = null
      } else {
        const readBackResult = await this.readBackRefreshedTokens(credentialsJson, {
          updateLastWrittenCredentialsJson: true
        })
        if (readBackResult.status === 'persisted') {
          const updatedCredentialsJson = await this.readManagedCredentials(account)
          if (updatedCredentialsJson && this.isValidCredentialsJsonObject(updatedCredentialsJson)) {
            credentialsJson = updatedCredentialsJson
          }
        }
      }
      // Why: refreshing while a live Claude holds this account's credentials
      // would double-rotate the single-use refresh token and log that session
      // out; the read-back above preserves whatever it rotated instead.
      if (!hasLiveClaudePtysForAccount(account.id)) {
        const refreshed = await this.refreshManagedAccountTokenIfNeeded(account, credentialsJson)
        if (refreshed) {
          credentialsJson = refreshed
        }
      }
      this.writeRuntimeCredentials(credentialsJson)
      if (process.platform === 'darwin') {
        // Why: pinned, so this writes the account's dir-scoped Keychain item
        // only — the shared unscoped item stays the user's.
        await this.writeActiveRuntimeKeychainCredentials(credentialsJson)
      }
      this.writeRuntimeOauthAccount(await this.readManagedOauthAccount(account))
    } finally {
      this.pinnedAccountConfigDir = null
      this.restoreLastWrittenRuntimeState(selectionRuntimeState)
    }
  }

  /**
   * Undoes the pre-isolation materialization: restores the captured
   * system-default snapshot into ~/.claude once no session can still be
   * reading it.
   *
   * Runs unpinned by construction — its subject is the user's own surface, and
   * restoreSystemDefaultSnapshot would otherwise follow a pin onto an account
   * dir and wipe the account's freshly materialized credentials.
   */
  protected async releaseLegacySharedSurface(
    account: ClaudeManagedAccount,
    credentialsJson: string
  ): Promise<void> {
    this.assertSharedSurfaceRestore('releaseLegacySharedSurface')
    if (!existsSync(this.getSystemDefaultSnapshotPath())) {
      return
    }
    if (hasLiveClaudeSessionsOnSharedSurface()) {
      return
    }
    const sharedGrantJson = await this.sharedSurfaceGrantBytes(credentialsJson)
    if (sharedGrantJson === null) {
      return
    }
    // Why: whatever this service last wrote belongs to some account's own dir,
    // so it proves nothing about ~/.claude. The proof that Orca owns the shared
    // surface is this account's grant sitting on it right now.
    this.clearLastWrittenRuntimeState()
    await this.restoreSystemDefaultSnapshot(
      sharedGrantJson,
      await this.readManagedOauthAccount(account)
    )
  }

  /**
   * Whether a live Claude owns the credentials this sync is about to touch.
   *
   * With a pinned account that is only that account's own sessions; on the
   * shared surface it is any session that may be reading ~/.claude, including
   * one whose binding this process cannot prove.
   */
  protected hasLiveClaudeOwnerForActiveSurface(accountId: string): boolean {
    return this.pinnedAccountConfigDir
      ? hasLiveClaudePtysForAccount(accountId)
      : hasLiveClaudeSessionsOnSharedSurface()
  }

  /**
   * Whether a Claude started before per-account isolation still holds this
   * account's grant on the shared surface.
   *
   * A refresh token is single-use: if that session rotates it while a newly
   * isolated CLI holds a copy of the same grant, one of the two is invalidated
   * and the user is logged out mid-session. So the account waits rather than
   * racing. The test is the grant itself, not merely "something is live" — an
   * account whose token is not the one on the shared surface is already
   * isolated and must keep launching.
   */
  protected async isLegacySharedGrantStillOwned(credentialsJson: string): Promise<boolean> {
    if (!hasLiveClaudeSessionsOnSharedSurface()) {
      return false
    }
    return (await this.sharedSurfaceGrantBytes(credentialsJson)) !== null
  }

  /** The bytes the user's own ~/.claude currently carries for this grant — the
   *  same blob, or the same refresh token under a rotated access token — or
   *  null when the shared surface holds someone else's credentials. */
  protected async sharedSurfaceGrantBytes(credentialsJson: string): Promise<string | null> {
    const sharedPaths = this.pathResolver.getRuntimePaths()
    const sharedCredentials: (string | null)[] = [
      existsSync(sharedPaths.credentialsPath)
        ? readFileSync(sharedPaths.credentialsPath, 'utf-8')
        : null
    ]
    if (process.platform === 'darwin') {
      sharedCredentials.push(await this.readActiveClaudeKeychainCredentialsBestEffort())
    }
    return (
      sharedCredentials.find(
        (candidate) =>
          candidate !== null &&
          (candidate === credentialsJson ||
            this.compareRefreshTokens(candidate, credentialsJson) === 'same')
      ) ?? null
    )
  }
}
