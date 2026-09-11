import type {
  ProviderRateLimits,
  UsageRateLimitFailureKind,
  UsageRateLimitMetadata,
  UsageRateLimitSource
} from '../../shared/rate-limit-types'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import type { ClaudeOAuthCredentialReadResult } from './claude-oauth-credentials'
import { OAuthUsageError } from './claude-oauth-usage-error'

export type ClaudeUsageAttemptState = {
  attemptedSources: UsageRateLimitSource[]
}

// Why: an abort still ran against a specific auth surface, and the retention
// policy discards a sample whose identity a later result cannot match. A lane
// that knows which account it was bound to must say so, or its own next read
// looks like a different account's.
export function abortedClaudeRateLimitResult(authProvenance?: string): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Rate-limit fetch aborted',
    status: 'error',
    ...(authProvenance ? { usageMetadata: { authProvenance } } : {})
  }
}

// Why: the active lane's surface is the managed account when one is prepared,
// and the user's own shared ~/.claude otherwise — never an unknown identity.
export function resolveClaudeAuthProvenance(
  authPreparation: ClaudeRuntimeAuthPreparation | undefined
): string {
  return authPreparation?.provenance ?? 'system'
}

export function recordClaudeUsageAttempt(
  state: ClaudeUsageAttemptState,
  source: UsageRateLimitSource
): UsageRateLimitSource[] {
  if (!state.attemptedSources.includes(source)) {
    state.attemptedSources.push(source)
  }
  return state.attemptedSources
}

export function withClaudeUsageMetadata(
  limits: ProviderRateLimits,
  metadata: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    ...limits,
    usageMetadata: {
      ...limits.usageMetadata,
      ...metadata,
      attemptedSources: metadata.attemptedSources ?? limits.usageMetadata?.attemptedSources
    }
  }
}

export function makeClaudeUsageResult(
  status: ProviderRateLimits['status'],
  error: string | null,
  metadata: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: metadata
  }
}

export function metadataForClaudeUsageAttempt(input: {
  attemptedSources: UsageRateLimitSource[]
  oauthCredentials: ClaudeOAuthCredentialReadResult
  authPreparation?: ClaudeRuntimeAuthPreparation
  /** Explicit surface identity for lanes that carry no ClaudeRuntimeAuthPreparation (inactive accounts). */
  authProvenance?: string
  source?: UsageRateLimitSource
  failureKind?: UsageRateLimitFailureKind
  deferredByLiveClaudeSession?: boolean
  retryAtMs?: number
}): UsageRateLimitMetadata {
  return {
    source: input.source,
    attemptedSources: [...input.attemptedSources],
    failureKind: input.failureKind,
    credentialSource: input.oauthCredentials.source,
    authProvenance: input.authProvenance ?? resolveClaudeAuthProvenance(input.authPreparation),
    deferredByLiveClaudeSession: input.deferredByLiveClaudeSession,
    retryAtMs: input.retryAtMs
  }
}

export function warnClaudeUsageFetchFailure(
  authPreparation: ClaudeRuntimeAuthPreparation | undefined,
  credentials: ClaudeOAuthCredentialReadResult,
  error: unknown
): void {
  console.warn('[claude-rate-limits] Claude usage refresh failed', {
    provenance: authPreparation?.provenance ?? 'system',
    runtime: authPreparation?.runtime ?? 'host',
    wslDistro: authPreparation?.wslDistro ?? null,
    hasExplicitClaudeConfigDir: Boolean(authPreparation?.envPatch.CLAUDE_CONFIG_DIR),
    credentialSource: credentials.source,
    keychainUnavailable: credentials.keychainUnavailable,
    hasRefreshableCredentials: credentials.hasRefreshableCredentials,
    status: error instanceof OAuthUsageError ? error.status : null,
    message: error instanceof Error ? error.message : String(error)
  })
}

export function mergeClaudeUsageWindows(
  primary: ProviderRateLimits,
  supplement: ProviderRateLimits | null
): ProviderRateLimits {
  if (!supplement) {
    return primary
  }
  return {
    ...primary,
    session: primary.session ?? supplement.session,
    weekly: primary.weekly ?? supplement.weekly,
    fableWeekly: primary.fableWeekly ?? supplement.fableWeekly ?? null
  }
}

export function canSupplementClaudeOAuthUsage(input: {
  oauthLimits: ProviderRateLimits
  authPreparation?: ClaudeRuntimeAuthPreparation
  allowUsagePanelSupplement: boolean
}): boolean {
  return Boolean(
    input.allowUsagePanelSupplement &&
    !input.authPreparation?.managedRefreshDeferredByLivePty &&
    !input.oauthLimits.fableWeekly &&
    (input.oauthLimits.session || input.oauthLimits.weekly)
  )
}

export function isManagedClaudeAuth(
  authPreparation: ClaudeRuntimeAuthPreparation | undefined
): boolean {
  return authPreparation?.provenance.startsWith('managed:') === true
}
