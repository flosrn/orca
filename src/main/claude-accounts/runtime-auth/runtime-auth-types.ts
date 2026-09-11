import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import type { ClaudeEnvPatch } from '../environment'

/** Which credential surface a launch was pinned to. Mirrors the live-PTY gate's
 *  binding routes so a spawn can record what it actually launched against. */
export type ClaudeConfigDirRoute = 'account-dir' | 'wsl-dir' | 'shared-dir'

export type ClaudeRuntimeAuthPreparation = {
  configDir: string
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxConfigDir?: string | null
  envPatch: ClaudeEnvPatch
  stripAuthEnv: boolean
  managedRefreshDeferredByLivePty?: boolean
  /** A Claude started before per-account isolation still owns this account's
   *  grant on the shared surface, so nothing was materialized into its dir and
   *  a launch must be refused rather than race that session's token rotation. */
  legacySharedGrantBlocked?: boolean
  /** The managed account this launch is pinned to, or null for the user's own
   *  ~/.claude. Absent only on hand-built fixtures, which are read as shared. */
  accountId?: string | null
  configDirRoute?: ClaudeConfigDirRoute
  provenance: string
}

export type ClaudeSystemDefaultSnapshot = {
  credentialsJson: string | null
  configOauthAccount: unknown
  keychainCredentialsJson: string | null
  scopedKeychainCredentialsJson?: string | null
  legacyKeychainCredentialsJson?: string | null
  scopedKeychainCredentialsCaptured?: boolean
  legacyKeychainCredentialsCaptured?: boolean
  capturedAt: number
}

/** A snapshot of the "what did Orca last write, and where" bookkeeping, so a
 *  materialization onto a surface outside the current selection can be undone
 *  from the selection's point of view. */
export type ClaudeLastWrittenRuntimeState = {
  lastWrittenCredentialsJson: string | null
  lastWrittenOauthAccount: unknown
  hasLastWrittenOauthAccount: boolean
  lastWrittenRuntimeConfigDir: string | null
  hasMaterializedRuntimeAuth: boolean
}

export type ClaudeAuthIdentity = {
  accountUuid: string | null
  email: string | null
  organizationUuid: string | null
}

export type ClaudeReadBackResult =
  | { status: 'unchanged' | 'persisted' }
  | {
      status: 'rejected'
      runtimeCredentialsChanged: boolean
      hasValidChangedRuntimeCredentials: boolean
      runtimeCredentialsJson?: string
    }
export type ClaudeReadBackMatch =
  | { kind: 'matched'; account: ClaudeManagedAccount; managedCredentialsJson: string }
  | { kind: 'none' | 'ambiguous' }
export type ClaudeKeychainReadResult =
  | { status: 'captured'; credentialsJson: string | null }
  | { status: 'failed' }
export type ClaudeKeychainSnapshotValue =
  | { status: 'captured'; credentialsJson: string | null }
  | { status: 'unknown' }
export type ClaudeRefreshTokenComparison = 'same' | 'different' | 'missing'
export type ClaudeRuntimeCredentialCandidate = {
  credentialsJson: string
  runtimeOauthAccount: unknown
}

export const RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR = Symbol('runtime-oauth-account-parse-error')
