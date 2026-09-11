import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => values[k] ?? '') : fallback
}))

import {
  getRetainedSampleNotice,
  getUsageRetryCountdownLabel,
  isUsageWindowExpired
} from './usage-stale-sample'

const NOW = Date.parse('2026-09-11T12:00:00Z')

function provider(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: 'Claude rate limited the usage refresh.',
    status: 'error',
    ...overrides
  }
}

function window(overrides: Partial<RateLimitWindow> = {}): RateLimitWindow {
  return {
    usedPercent: 41,
    windowMinutes: 300,
    resetsAt: null,
    resetDescription: null,
    ...overrides
  }
}

describe('getRetainedSampleNotice', () => {
  it('dates the retained numbers by their last successful capture', () => {
    expect(getRetainedSampleNotice(provider({ updatedAt: NOW - 12 * 60_000 }), NOW)).toBe(
      'last read 12m ago'
    )
    expect(getRetainedSampleNotice(provider({ updatedAt: NOW - 5 * 3_600_000 }), NOW)).toBe(
      'last read 5h ago'
    )
  })

  it('says a capture just happened rather than printing a zero age', () => {
    expect(getRetainedSampleNotice(provider({ updatedAt: NOW - 5_000 }), NOW)).toBe(
      'last read just now'
    )
  })

  it('admits there is no earlier reading when nothing was ever captured', () => {
    // Why: updatedAt is 0 on a provider that has never returned data; an age
    // computed from the epoch would claim a 56-year-old sample.
    expect(getRetainedSampleNotice(provider({ updatedAt: 0 }), NOW)).toBe('no earlier reading')
    expect(getRetainedSampleNotice(provider({ updatedAt: Number.NaN }), NOW)).toBe(
      'no earlier reading'
    )
  })

  it('does not report a capture from the future as an age', () => {
    expect(getRetainedSampleNotice(provider({ updatedAt: NOW + 60_000 }), NOW)).toBe(
      'no earlier reading'
    )
  })
})

describe('isUsageWindowExpired', () => {
  it('treats a window whose reset has already passed as expired', () => {
    expect(isUsageWindowExpired(window({ resetsAt: NOW - 1 }), NOW)).toBe(true)
    expect(isUsageWindowExpired(window({ resetsAt: NOW }), NOW)).toBe(true)
  })

  it('keeps a still-open window unexpired', () => {
    expect(isUsageWindowExpired(window({ resetsAt: NOW + 60_000 }), NOW)).toBe(false)
  })

  it('cannot call a window with no known reset expired', () => {
    expect(isUsageWindowExpired(window({ resetsAt: null }), NOW)).toBe(false)
  })
})

describe('getUsageRetryCountdownLabel', () => {
  it('reports the provider-supplied retry deadline as a countdown', () => {
    expect(
      getUsageRetryCountdownLabel(
        provider({ usageMetadata: { failureKind: 'rate-limited', retryAtMs: NOW + 90 * 60_000 } }),
        NOW
      )
    ).toBe('retry in 1h 30m')
  })

  it('stays silent when the response carried no Retry-After', () => {
    expect(
      getUsageRetryCountdownLabel(provider({ usageMetadata: { failureKind: 'rate-limited' } }), NOW)
    ).toBeNull()
  })

  it('stays silent once the retry deadline has passed', () => {
    expect(
      getUsageRetryCountdownLabel(
        provider({ usageMetadata: { failureKind: 'rate-limited', retryAtMs: NOW - 1 } }),
        NOW
      )
    ).toBeNull()
  })
})
