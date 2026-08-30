import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  isOauthTokenExpired,
  isOauthTokenExpiring,
  refreshClaudeOauthCredentialsOutcome,
  type ClaudeOauthRefreshFailure
} from '../claude-accounts/oauth-refresh'
import {
  readClaudeManagedCredentialsJson,
  resolveClaudeManagedCredentialsLocation,
  writeClaudeManagedCredentialsJson,
  type InactiveClaudeAccount
} from './claude-managed-account-credentials'
import { fetchClaudeManagedUsagePanelSupplement } from './claude-managed-usage-panel'
import { parseClaudeOAuthCredentialsJson } from './claude-oauth-credentials'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import type { ClaudeManagedAccountUsageOptions } from './claude-usage-fetch-options'
import {
  abortedClaudeRateLimitResult,
  canSupplementClaudeOAuthUsage,
  makeClaudeUsageResult,
  mergeClaudeUsageWindows,
  metadataForClaudeUsageAttempt,
  warnClaudeUsageFetchFailure
} from './claude-usage-result'

function noClaudeManagedCredentialsResult(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'No credentials',
    status: 'error'
  }
}

// Why: a hard-expired bearer is a guaranteed 401 that feeds per-token
// throttling; report the refresh failure instead of replaying it.
function staleClaudeManagedCredentialsResult(
  credentialsJson: string,
  failure: ClaudeOauthRefreshFailure | null
): ProviderRateLimits {
  const oauthCredentials = parseClaudeOAuthCredentialsJson(credentialsJson, 'credentials-file')
  const rateLimited = failure?.status === 429
  const rejected = failure?.status === 400 || failure?.status === 401
  const retryAfterMs = failure?.retryAfterMs
  return makeClaudeUsageResult(
    'error',
    rateLimited
      ? 'Claude token refresh is rate limited right now.'
      : rejected || !oauthCredentials.hasRefreshableCredentials
        ? 'Claude token refresh was rejected. Re-authenticate this account.'
        : (failure?.message ?? 'Claude token refresh failed.'),
    metadataForClaudeUsageAttempt({
      attemptedSources: ['oauth'],
      oauthCredentials,
      source: 'oauth',
      failureKind: rateLimited
        ? 'rate-limited'
        : rejected || !oauthCredentials.hasRefreshableCredentials
          ? 'stale-token'
          : 'network',
      retryAtMs: retryAfterMs ? Date.now() + retryAfterMs : undefined
    })
  )
}

export async function fetchInactiveClaudeAccountUsage(
  account: InactiveClaudeAccount,
  options: ClaudeManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const location = resolveClaudeManagedCredentialsLocation(account)
  let credentialsJson = location ? await readClaudeManagedCredentialsJson(location) : null
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (!location || !credentialsJson) {
    return noClaudeManagedCredentialsResult()
  }

  let token = parseClaudeOAuthCredentialsJson(credentialsJson, 'credentials-file').token
  if (isOauthTokenExpiring(credentialsJson)) {
    const { credentialsJson: refreshed, failure } =
      await refreshClaudeOauthCredentialsOutcome(credentialsJson)
    if (options.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    if (refreshed) {
      try {
        await writeClaudeManagedCredentialsJson(location, refreshed)
      } catch {
        // Keep the refreshed token for this fetch; a later poll can persist it.
      }
      credentialsJson = refreshed
      token = parseClaudeOAuthCredentialsJson(refreshed, 'credentials-file').token
    } else if (isOauthTokenExpired(credentialsJson)) {
      return staleClaudeManagedCredentialsResult(credentialsJson, failure)
    }
    // Why: within the refresh buffer the stored bearer is still valid; use it.
  }

  if (!token) {
    return noClaudeManagedCredentialsResult()
  }
  const oauthLimits = await fetchClaudeOAuthUsage(token, options.signal)
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (
    !canSupplementClaudeOAuthUsage({
      oauthLimits,
      authPreparation: undefined,
      allowUsagePanelSupplement: options.allowUsagePanelSupplement === true
    })
  ) {
    return oauthLimits
  }

  try {
    return mergeClaudeUsageWindows(
      oauthLimits,
      await fetchClaudeManagedUsagePanelSupplement({
        account,
        location,
        credentialsJson,
        oauthLimits,
        networkProxySettings: options.networkProxySettings,
        signal: options.signal
      })
    )
  } catch (error) {
    warnClaudeUsageFetchFailure(
      undefined,
      parseClaudeOAuthCredentialsJson(credentialsJson, 'credentials-file'),
      error
    )
    return oauthLimits
  }
}
