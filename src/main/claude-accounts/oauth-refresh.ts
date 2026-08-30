import { net, session } from 'electron'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { parseRetryAfterMs } from '../rate-limits/claude-oauth-usage-error'

// Why: the OAuth client id and token endpoint are the public Claude Code
// values, verified against the installed `claude` binary (2.1.177) and the
// claude-swap reference tool. Orca owns the refresh so a single-use refresh
// token is rotated and persisted atomically, instead of being scraped back
// after the CLI rotates it (the lossy path that strands stale tokens).
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

// Refresh slightly ahead of expiry so a token doesn't expire mid-launch. The
// CLI uses the same 5-minute skew for its own refresh decision.
const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000
const REFRESH_TIMEOUT_MS = 10_000
// Why: refresh tokens are single-use; a failed or just-consumed token must not
// be re-POSTed by the next caller in the same window.
const FAILED_REFRESH_MEMO_MS = 60 * 1000
const ROTATED_TOKEN_MEMO_MS = 60 * 1000

type ClaudeOauthBlob = {
  accessToken?: unknown
  refreshToken?: unknown
  expiresAt?: unknown
  scopes?: unknown
  [key: string]: unknown
}

type ClaudeCredentials = {
  claudeAiOauth?: ClaudeOauthBlob
  [key: string]: unknown
}

type TokenEndpointResponse = {
  access_token?: unknown
  expires_in?: unknown
  refresh_token?: unknown
  scope?: unknown
}

export type ClaudeOauthRefreshFailure = {
  status: number | null
  retryAfterMs: number | null
  message: string
}

export type ClaudeOauthRefreshOutcome = {
  credentialsJson: string | null
  failure: ClaudeOauthRefreshFailure | null
}

type SharedClaudeOauthRefresh = {
  response: TokenEndpointResponse | null
  failure: ClaudeOauthRefreshFailure | null
  reusableUntilMs: number
}

// Why: the usage poll and the runtime switch-in can hold the same single-use
// refresh token; two live exchanges strand whichever rotation loses.
const refreshFlightsByToken = new Map<string, Promise<SharedClaudeOauthRefresh>>()
const recentRefreshByToken = new Map<string, SharedClaudeOauthRefresh>()

export function resetClaudeOauthRefreshRuntimeStateForTest(): void {
  refreshFlightsByToken.clear()
  recentRefreshByToken.clear()
}

/**
 * Parse the `claudeAiOauth` object from a credentials JSON string.
 * Returns null when the string is not parseable or lacks the OAuth block.
 */
export function parseClaudeOauthBlob(credentialsJson: string): ClaudeOauthBlob | null {
  try {
    const parsed = JSON.parse(credentialsJson) as ClaudeCredentials
    const oauth = parsed?.claudeAiOauth
    return oauth && typeof oauth === 'object' && !Array.isArray(oauth) ? oauth : null
  } catch {
    return null
  }
}

/** Read a stored refresh token, or null when absent/blank. */
export function readRefreshToken(credentialsJson: string): string | null {
  const oauth = parseClaudeOauthBlob(credentialsJson)
  const token = oauth?.refreshToken
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null
}

/**
 * Whether the stored access token is expired or within the refresh buffer.
 *
 * A missing/non-numeric `expiresAt` is treated as "needs refresh" so a blob
 * with no usable expiry metadata still gets a proactive refresh attempt rather
 * than being trusted indefinitely. `now` is injectable for tests.
 */
export function isOauthTokenExpiring(credentialsJson: string, now: number = Date.now()): boolean {
  const oauth = parseClaudeOauthBlob(credentialsJson)
  if (!oauth) {
    return false
  }
  const expiresAt = oauth.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return true
  }
  return now + OAUTH_EXPIRY_BUFFER_MS >= expiresAt
}

/**
 * Provably past `expiresAt`, with no buffer. Missing expiry metadata is NOT
 * proof — expiresAt is not authoritative for the usage endpoint, so a bearer
 * without it is still handed to the server to judge.
 */
export function isOauthTokenExpired(credentialsJson: string, now: number = Date.now()): boolean {
  const oauth = parseClaudeOauthBlob(credentialsJson)
  if (!oauth) {
    return false
  }
  const expiresAt = oauth.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return false
  }
  return now >= expiresAt
}

/**
 * Merge a token-endpoint response into the stored credentials, returning the
 * updated credentials JSON. Preserves every field the caller already had
 * (including the refresh token when the server does not rotate it) and only
 * overwrites what the response provides. Returns null on malformed input.
 */
export function applyRefreshedToken(
  credentialsJson: string,
  response: TokenEndpointResponse,
  now: number = Date.now()
): string | null {
  let parsed: ClaudeCredentials
  try {
    parsed = JSON.parse(credentialsJson) as ClaudeCredentials
  } catch {
    return null
  }
  const accessToken = response.access_token
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    return null
  }
  const oauth: ClaudeOauthBlob = { ...parsed.claudeAiOauth }
  oauth.accessToken = accessToken
  if (typeof response.expires_in === 'number' && Number.isFinite(response.expires_in)) {
    oauth.expiresAt = now + response.expires_in * 1000
  }
  // Rotation: keep the existing refresh token unless the server issued a new
  // one. Single-use refresh tokens make persisting the rotated value the whole
  // point of owning refresh.
  if (typeof response.refresh_token === 'string' && response.refresh_token.trim() !== '') {
    oauth.refreshToken = response.refresh_token
  }
  if (typeof response.scope === 'string' && response.scope.trim() !== '') {
    oauth.scopes = response.scope.split(' ')
  }
  parsed.claudeAiOauth = oauth
  return JSON.stringify(parsed)
}

/**
 * Refresh the OAuth token for a stored credentials blob.
 *
 * Returns the updated credentials JSON (with the rotated refresh token and new
 * access token) on success, or null on any failure. Never throws — callers
 * treat null as "keep the existing credentials", so a transient network error
 * is never worse than today's behavior.
 */
export async function refreshClaudeOauthCredentials(
  credentialsJson: string,
  now: number = Date.now()
): Promise<string | null> {
  return (await refreshClaudeOauthCredentialsOutcome(credentialsJson, now)).credentialsJson
}

/**
 * Refresh with an explicit failure report, deduplicated per refresh token.
 *
 * All callers share one in-flight exchange per token, and a caller whose
 * snapshot still holds a just-consumed or just-rejected token is served the
 * memoized result instead of burning another POST.
 */
export async function refreshClaudeOauthCredentialsOutcome(
  credentialsJson: string,
  now: number = Date.now()
): Promise<ClaudeOauthRefreshOutcome> {
  const refreshToken = readRefreshToken(credentialsJson)
  if (!refreshToken) {
    return {
      credentialsJson: null,
      failure: { status: null, retryAfterMs: null, message: 'No refresh token stored' }
    }
  }
  const recent = recentRefreshByToken.get(refreshToken)
  if (recent && now < recent.reusableUntilMs) {
    return outcomeFromSharedRefresh(credentialsJson, recent, now)
  }
  let flight = refreshFlightsByToken.get(refreshToken)
  if (!flight) {
    flight = exchangeClaudeRefreshToken(refreshToken).finally(() => {
      refreshFlightsByToken.delete(refreshToken)
    })
    refreshFlightsByToken.set(refreshToken, flight)
  }
  return outcomeFromSharedRefresh(credentialsJson, await flight, now)
}

function outcomeFromSharedRefresh(
  credentialsJson: string,
  shared: SharedClaudeOauthRefresh,
  now: number
): ClaudeOauthRefreshOutcome {
  if (!shared.response) {
    return { credentialsJson: null, failure: shared.failure }
  }
  const applied = applyRefreshedToken(credentialsJson, shared.response, now)
  return applied
    ? { credentialsJson: applied, failure: null }
    : {
        credentialsJson: null,
        failure: {
          status: null,
          retryAfterMs: null,
          message: 'Token endpoint returned an unusable response'
        }
      }
}

async function exchangeClaudeRefreshToken(refreshToken: string): Promise<SharedClaudeOauthRefresh> {
  await ensureElectronProxyFromEnvironment({
    proxySession: session.defaultSession,
    probeUrl: OAUTH_TOKEN_URL
  }).catch(() => {})

  try {
    // Why: the `claude` CLI posts grant_type=refresh_token as
    // application/x-www-form-urlencoded with the public client id. net.fetch
    // routes through Chromium's stack so the env proxy bridge above applies.
    const res = await net.fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID
      }).toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS)
    })
    if (!res.ok) {
      // Why: surface the status (never the token) so a throttle (429) or a
      // dead refresh token (400/401 invalid_grant) is diagnosable in the
      // field, instead of a silent null that looks identical to success.
      console.warn(`[claude-oauth-refresh] token endpoint returned ${res.status}`)
      const retryAfterMs =
        res.status === 429
          ? (parseRetryAfterMs(res.headers?.get('retry-after') ?? null) ?? FAILED_REFRESH_MEMO_MS)
          : null
      return rememberSharedRefresh(refreshToken, {
        response: null,
        failure: {
          status: res.status,
          retryAfterMs,
          message: `Token refresh failed (${res.status})`
        },
        // Why: a 429 honors Retry-After; a rejected token is memoized briefly
        // to absorb poll bursts without delaying recovery after a re-auth.
        reusableUntilMs: Date.now() + (retryAfterMs ?? FAILED_REFRESH_MEMO_MS)
      })
    }
    const data = (await res.json()) as TokenEndpointResponse
    return rememberSharedRefresh(refreshToken, {
      response: data,
      failure: null,
      // Why: a caller whose snapshot predates this rotation would otherwise
      // POST the now-consumed token; serve it the rotation instead.
      reusableUntilMs: Date.now() + ROTATED_TOKEN_MEMO_MS
    })
  } catch (error) {
    console.warn(
      '[claude-oauth-refresh] token refresh request failed:',
      error instanceof Error ? error.message : error
    )
    // Why: transient network errors are not memoized; the next attempt may retry at once.
    return {
      response: null,
      failure: {
        status: null,
        retryAfterMs: null,
        message: error instanceof Error ? error.message : String(error)
      },
      reusableUntilMs: 0
    }
  }
}

function rememberSharedRefresh(
  refreshToken: string,
  shared: SharedClaudeOauthRefresh
): SharedClaudeOauthRefresh {
  // Why: opportunistic sweep keeps the memo bounded without a timer.
  for (const [key, value] of recentRefreshByToken) {
    if (Date.now() >= value.reusableUntilMs) {
      recentRefreshByToken.delete(key)
    }
  }
  recentRefreshByToken.set(refreshToken, shared)
  return shared
}
