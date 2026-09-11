import type { Store } from '../../persistence'
import { ClaudeRuntimePathResolver } from '../runtime-paths'

export class ClaudeRuntimeAuthState {
  protected readonly pathResolver = new ClaudeRuntimePathResolver()
  protected mutationQueue: Promise<unknown> = Promise.resolve()
  protected lastSyncedAccountId: string | null = null
  // Why: creds Orca last wrote to the shared file; a mismatch on managed→default transition means an external login overwrote it, so adopt it as the new default.
  protected lastWrittenCredentialsJson: string | null = null
  protected hasMaterializedRuntimeAuth = false
  protected hasLastWrittenOauthAccount = false
  protected lastWrittenOauthAccount: unknown = null
  /**
   * The config dir `lastWrittenCredentialsJson` and `lastWrittenOauthAccount`
   * describe: an account's own dir, or null for the user's ~/.claude.
   *
   * Ownership of the shared surface may only be claimed by a write that went
   * there. A write into an account dir proves nothing about ~/.claude, and
   * treating it as proof would let a deselect erase credentials or oauth
   * metadata Orca never put there.
   */
  protected lastWrittenRuntimeConfigDir: string | null = null
  protected skipNextReadBackForAccountId: string | null = null
  protected managedRefreshDeferredByLivePtyAccountId: string | null = null
  /**
   * The config dir the CURRENT selection materializes into, when that is a host
   * managed account's own directory rather than the user's ~/.claude.
   *
   * Set for the duration of a sync by doSyncForCurrentSelection. Everything
   * that reads or writes "the runtime" — credentials file, .claude.json oauth
   * metadata, scoped Keychain item, read-back of CLI refreshes — follows it, so
   * the existing materialization logic operates on the account's surface
   * without a second implementation. The system-default snapshot deliberately
   * does not: its subject is always the user's own ~/.claude.
   */
  protected pinnedAccountConfigDir: string | null = null
  /**
   * An account whose isolation is deferred because a Claude started before
   * per-account isolation still owns its grant on the shared surface. Launches
   * for it are refused (rather than silently run against ~/.claude) until that
   * session drains; see runtime-auth-sync's isLegacySharedGrantStillOwned.
   */
  protected legacySharedGrantBlockedAccountId: string | null = null

  protected constructor(protected readonly store: Store) {}
}
