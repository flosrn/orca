import { rmSync } from 'node:fs'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import { deleteActiveClaudeKeychainCredentialsStrict } from '../keychain'
import { ClaudeRuntimeAuthSnapshotCapture } from './runtime-auth-snapshot-capture'
import type { ClaudeKeychainSnapshotValue } from './runtime-auth-types'

export class ClaudeRuntimeAuthSnapshotRestore extends ClaudeRuntimeAuthSnapshotCapture {
  /**
   * Refuses to run a shared-surface operation while an account pin is set.
   *
   * These helpers take their Keychain and config dir from
   * `pathResolver.getRuntimePaths()` (the user's own ~/.claude) but reach the
   * credentials file and `.claude.json` through `getActiveRuntimePaths()`,
   * which follows the pin. Running them pinned mixes the two surfaces: the
   * user's snapshot credentials and oauth identity land in a managed account's
   * config dir (or its `.credentials.json` is deleted). The pin is scoped to a
   * single sync, so reaching here with one set is a bug in the caller.
   */
  protected assertSharedSurfaceRestore(operation: string): void {
    if (this.pinnedAccountConfigDir !== null) {
      throw new Error(`${operation} must run against the shared surface`)
    }
  }

  protected async restoreSystemDefaultSnapshot(
    ownedCredentialsJson?: string | null,
    ownedOauthAccount?: unknown
  ): Promise<void> {
    this.assertSharedSurfaceRestore('restoreSystemDefaultSnapshot')
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    const paths = this.pathResolver.getRuntimePaths()
    // Why: only a write that went to ~/.claude proves Orca owns what is there.
    // A pinned account's last write describes its own dir, and accepting it
    // here would delete the user's own credentials or oauth metadata.
    const sharedLastWrittenCredentialsJson =
      this.lastWrittenRuntimeConfigDir === null ? this.lastWrittenCredentialsJson : null
    const previouslyWrittenCredentialsJson =
      sharedLastWrittenCredentialsJson ?? ownedCredentialsJson ?? null
    const snapshot = this.readSystemDefaultSnapshot(snapshotPath)

    const fileCredentialsOwned = this.hasUnchangedRuntimeCredentials(
      previouslyWrittenCredentialsJson
    )
    let hasCredentialSurfaceOwnership = fileCredentialsOwned
    // Why: prove ownership before mutating anything, and restore OAuth first so a failure leaves the credential proof intact for retry.
    this.lastWrittenCredentialsJson = previouslyWrittenCredentialsJson
    let scopedSnapshot: ClaudeKeychainSnapshotValue | null = null
    let legacySnapshot: ClaudeKeychainSnapshotValue | null = null
    let scopedKeychainOwned = false
    let legacyKeychainOwned = false
    if (process.platform === 'darwin') {
      scopedSnapshot = this.readKeychainSnapshotValue(snapshot, 'scoped')
      legacySnapshot = this.readKeychainSnapshotValue(snapshot, 'legacy')
      scopedKeychainOwned = await this.hasUnchangedActiveClaudeKeychainCredentials(
        scopedSnapshot,
        previouslyWrittenCredentialsJson,
        paths.configDir
      )
      legacyKeychainOwned = await this.hasUnchangedActiveClaudeKeychainCredentials(
        legacySnapshot,
        previouslyWrittenCredentialsJson
      )
      hasCredentialSurfaceOwnership =
        fileCredentialsOwned || scopedKeychainOwned || legacyKeychainOwned
    }
    this.restoreRuntimeOauthAccountIfOwned(
      snapshot?.configOauthAccount ?? null,
      this.getOwnedRuntimeOauthBaseline(ownedOauthAccount, hasCredentialSurfaceOwnership),
      { allowCredentialSurfaceOwnership: hasCredentialSurfaceOwnership }
    )
    if (fileCredentialsOwned) {
      this.restoreRuntimeCredentials(snapshot?.credentialsJson ?? null)
    }
    if (process.platform === 'darwin') {
      if (scopedSnapshot?.status === 'captured' && scopedKeychainOwned) {
        await this.restoreActiveClaudeKeychainCredentials(
          scopedSnapshot.credentialsJson,
          paths.configDir
        )
      }
      if (legacySnapshot?.status === 'captured' && legacyKeychainOwned) {
        await this.restoreActiveClaudeKeychainCredentials(legacySnapshot.credentialsJson)
      }
    }
    this.clearLastWrittenRuntimeState()
  }

  protected getOwnedRuntimeOauthBaseline(
    ownedOauthAccount: unknown,
    hasCredentialSurfaceOwnership: boolean
  ): unknown {
    if (this.hasLastWrittenOauthAccount && this.lastWrittenRuntimeConfigDir === null) {
      return this.lastWrittenOauthAccount
    }
    // Why: managed metadata hints identity but isn't proof Orca wrote .claude.json; use only after a credential surface proves ownership.
    if (hasCredentialSurfaceOwnership && ownedOauthAccount !== undefined) {
      return ownedOauthAccount
    }
    return null
  }

  protected async clearRuntimeAuthForAccount(
    account: ClaudeManagedAccount,
    managedOauthAccount: unknown
  ): Promise<void> {
    this.assertSharedSurfaceRestore('clearRuntimeAuthForAccount')
    const paths = this.pathResolver.getRuntimePaths()
    const fileCredentialsOwned = this.runtimeCredentialsBelongToAccount(
      this.readRuntimeCredentialsFile(),
      account,
      managedOauthAccount
    )
    let scopedKeychainOwned = false
    let legacyKeychainOwned = false
    if (process.platform === 'darwin') {
      scopedKeychainOwned = await this.hasActiveKeychainCredentialsForAccount(
        account,
        managedOauthAccount,
        paths.configDir
      )
      legacyKeychainOwned = await this.hasActiveKeychainCredentialsForAccount(
        account,
        managedOauthAccount
      )
    }
    const hasCredentialSurfaceOwnership =
      fileCredentialsOwned || scopedKeychainOwned || legacyKeychainOwned
    this.restoreRuntimeOauthAccountIfOwned(
      null,
      this.getOwnedRuntimeOauthBaseline(managedOauthAccount, hasCredentialSurfaceOwnership),
      {
        allowCredentialSurfaceOwnership: hasCredentialSurfaceOwnership
      }
    )
    if (fileCredentialsOwned) {
      rmSync(paths.credentialsPath, { force: true })
    }
    if (process.platform === 'darwin') {
      if (scopedKeychainOwned) {
        await deleteActiveClaudeKeychainCredentialsStrict(paths.configDir)
      }
      if (legacyKeychainOwned) {
        await deleteActiveClaudeKeychainCredentialsStrict()
      }
    }
  }

  protected async restoreSystemDefaultSnapshotForMissingManagedCredentials(
    account: ClaudeManagedAccount,
    managedOauthAccount: unknown
  ): Promise<void> {
    this.assertSharedSurfaceRestore('restoreSystemDefaultSnapshotForMissingManagedCredentials')
    const snapshot = this.readSystemDefaultSnapshot(this.getSystemDefaultSnapshotPath())
    if (!snapshot) {
      await this.clearRuntimeAuthForAccount(account, managedOauthAccount)
      this.clearLastWrittenRuntimeState()
      return
    }
    const paths = this.pathResolver.getRuntimePaths()
    const fileCredentialsOwned = this.runtimeCredentialsBelongToAccount(
      this.readRuntimeCredentialsFile(),
      account,
      managedOauthAccount
    )
    let scopedSnapshot: ClaudeKeychainSnapshotValue | null = null
    let legacySnapshot: ClaudeKeychainSnapshotValue | null = null
    let scopedKeychainOwned = false
    let legacyKeychainOwned = false
    if (process.platform === 'darwin') {
      scopedSnapshot = this.readKeychainSnapshotValue(snapshot, 'scoped')
      legacySnapshot = this.readKeychainSnapshotValue(snapshot, 'legacy')
      scopedKeychainOwned = await this.hasActiveKeychainCredentialsForAccount(
        account,
        managedOauthAccount,
        paths.configDir
      )
      legacyKeychainOwned = await this.hasActiveKeychainCredentialsForAccount(
        account,
        managedOauthAccount
      )
    }
    const hasCredentialSurfaceOwnership =
      fileCredentialsOwned || scopedKeychainOwned || legacyKeychainOwned
    this.restoreRuntimeOauthAccountIfOwned(
      snapshot.configOauthAccount,
      this.getOwnedRuntimeOauthBaseline(managedOauthAccount, hasCredentialSurfaceOwnership),
      {
        allowCredentialSurfaceOwnership: hasCredentialSurfaceOwnership
      }
    )
    if (fileCredentialsOwned) {
      this.restoreRuntimeCredentials(snapshot.credentialsJson)
    }
    if (process.platform === 'darwin') {
      if (scopedSnapshot?.status === 'captured' && scopedKeychainOwned) {
        await this.restoreActiveClaudeKeychainCredentials(
          scopedSnapshot.credentialsJson,
          paths.configDir
        )
      }
      if (legacySnapshot?.status === 'captured' && legacyKeychainOwned) {
        await this.restoreActiveClaudeKeychainCredentials(legacySnapshot.credentialsJson)
      }
    }
    this.clearLastWrittenRuntimeState()
  }
}
