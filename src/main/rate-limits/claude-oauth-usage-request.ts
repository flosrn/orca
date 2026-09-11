import { net, session } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { createOAuthUsageError } from './claude-oauth-usage-error'
import { mapClaudeUsageWindow, type ClaudeUsageWindowInput } from './claude-usage-window'
import { abortedClaudeRateLimitResult } from './claude-usage-result'
import { logClaudeAuthDiagnostic } from './claude-auth-diagnostics-log'
import { OAuthUsageError } from './claude-oauth-usage-error'
import { takeClaudeUsagePollBudget } from './claude-usage-poll-budget'

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const API_TIMEOUT_MS = 10_000

type OAuthUsageLimit = {
  kind?: string
  percent?: number
  resets_at?: string | number
  is_active?: boolean
  scope?: { model?: { display_name?: string } | null } | null
}

type OAuthUsageResponse = {
  five_hour?: ClaudeUsageWindowInput
  seven_day?: ClaudeUsageWindowInput
  fable_weekly?: ClaudeUsageWindowInput
  fable_seven_day?: ClaudeUsageWindowInput
  seven_day_fable?: ClaudeUsageWindowInput
  limits?: OAuthUsageLimit[] | null
}

async function ensureProxyFromEnvironment(): Promise<void> {
  await ensureElectronProxyFromEnvironment({
    proxySession: session.defaultSession,
    probeUrl: OAUTH_USAGE_URL
  }).catch(() => {})
}

function mapFableWeeklyWindow(data: OAuthUsageResponse): RateLimitWindow | null {
  const scoped = Array.isArray(data.limits)
    ? data.limits.find(
        (limit) =>
          limit?.kind === 'weekly_scoped' &&
          Number.isFinite(limit.percent) &&
          limit.scope?.model?.display_name?.trim().toLowerCase() === 'fable'
      )
    : undefined
  return (
    mapClaudeUsageWindow(
      scoped ? { used_percentage: scoped.percent, resets_at: scoped.resets_at } : undefined,
      10080
    ) ??
    mapClaudeUsageWindow(data.fable_weekly, 10080) ??
    mapClaudeUsageWindow(data.fable_seven_day, 10080) ??
    mapClaudeUsageWindow(data.seven_day_fable, 10080)
  )
}

export async function fetchClaudeOAuthUsage(
  token: string,
  signal?: AbortSignal,
  // Why: the caller's surface identity doubles as the poll budget key — it must
  // survive token rotation, and every result must name the account it read.
  authProvenance?: string
): Promise<ProviderRateLimits> {
  if (signal?.aborted) {
    return abortedClaudeRateLimitResult(authProvenance)
  }
  // Why: the usage endpoint budgets ~28-30 reads per identity-hour; overshooting
  // earns per-token 429s with retry-after up to an hour, so defer locally first.
  const budget = takeClaudeUsagePollBudget(authProvenance ?? token)
  if (!budget.ok) {
    logClaudeAuthDiagnostic('claude-usage-budget-deferred', { retryAfterMs: budget.retryAfterMs })
    throw new OAuthUsageError(
      'Claude usage polling budget exhausted for this identity.',
      429,
      true,
      budget.retryAfterMs
    )
  }
  await ensureProxyFromEnvironment()
  if (signal?.aborted) {
    return abortedClaudeRateLimitResult(authProvenance)
  }

  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)

  try {
    const response = await net.fetch(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.0'
      },
      signal: requestSignal
    })
    if (!response.ok) {
      logClaudeAuthDiagnostic('claude-usage-error', {
        status: response.status,
        retryAfter: response.headers?.get('retry-after') ?? null
      })
      throw await createOAuthUsageError(response)
    }

    const data = (await response.json()) as OAuthUsageResponse
    if (signal?.aborted) {
      return abortedClaudeRateLimitResult(authProvenance)
    }
    return {
      provider: 'claude',
      session: mapClaudeUsageWindow(data.five_hour, 300),
      weekly: mapClaudeUsageWindow(data.seven_day, 10080),
      fableWeekly: mapFableWeeklyWindow(data),
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      ...(authProvenance ? { usageMetadata: { authProvenance } } : {})
    }
  } catch (error) {
    if (signal?.aborted) {
      return abortedClaudeRateLimitResult(authProvenance)
    }
    throw error
  }
}
