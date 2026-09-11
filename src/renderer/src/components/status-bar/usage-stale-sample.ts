import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { formatResetDuration } from '../../../../shared/rate-limit-reset-format'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'

// A failing refresh keeps the previous sample on screen; `updatedAt` then dates that sample
// rather than the failed attempt. These helpers keep the row honest about which it is showing.

function getSampleAgeLabel(p: ProviderRateLimits, now: number): string | null {
  const capturedAt = p.updatedAt
  // updatedAt is 0 on a provider that never returned data; an age from the epoch would
  // claim a decades-old sample, and a future timestamp is a clock skew we cannot date.
  if (!Number.isFinite(capturedAt) || capturedAt <= 0 || capturedAt > now) {
    return null
  }
  return formatShortTimeAgo(capturedAt, now)
}

/** Dates the numbers a stale row is still showing, or says there are none to date. */
export function getRetainedSampleNotice(p: ProviderRateLimits, now: number): string {
  const age = getSampleAgeLabel(p, now)
  if (age === null) {
    return translate(
      'auto.components.status.bar.UsageRosterPanel.stale.noSample',
      'no earlier reading'
    )
  }
  if (age === 'now') {
    return translate(
      'auto.components.status.bar.UsageRosterPanel.stale.justRead',
      'last read just now'
    )
  }
  return translate(
    'auto.components.status.bar.UsageRosterPanel.stale.lastRead',
    'last read {{age}} ago',
    { age }
  )
}

/**
 * True when a window's reset has already passed: it measured a quota period that no longer
 * exists, so its percentage cannot be shown as a reading whatever the refresh is doing.
 */
export function isUsageWindowExpired(window: RateLimitWindow, now: number): boolean {
  return (
    typeof window.resetsAt === 'number' &&
    Number.isFinite(window.resetsAt) &&
    window.resetsAt <= now
  )
}

/**
 * True while a refresh is failing — including the retry in flight, which the store overlays as
 * `fetching` on the failed sample without clearing its error.
 */
export function isProviderRefreshFailing(p: ProviderRateLimits): boolean {
  return p.status === 'error' || (p.status === 'fetching' && p.error !== null)
}

/** Countdown to the provider-supplied Retry-After deadline, when one was sent. */
export function getUsageRetryCountdownLabel(p: ProviderRateLimits, now: number): string | null {
  const retryAtMs = p.usageMetadata?.retryAtMs
  if (typeof retryAtMs !== 'number' || !Number.isFinite(retryAtMs) || retryAtMs <= now) {
    return null
  }
  return translate(
    'auto.components.status.bar.UsageRosterPanel.stale.retryIn',
    'retry in {{countdown}}',
    { countdown: formatResetDuration(retryAtMs - now) }
  )
}
