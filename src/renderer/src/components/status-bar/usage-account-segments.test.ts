import { describe, expect, it } from 'vitest'
import { buildUsageBarSegments } from './usage-account-segments'
import type { ManagedAccountUsageLane } from '../../../../shared/managed-account-usage-roster'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

function provider(id: ProviderRateLimits['provider'], usedPercent = 10): ProviderRateLimits {
  return {
    provider: id,
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

function lane(overrides: Partial<ManagedAccountUsageLane> = {}): ManagedAccountUsageLane {
  return {
    kind: 'managed',
    accountId: 'account-1',
    ordinal: 1,
    email: 'one@example.com',
    isActive: false,
    limits: null,
    isFetching: false,
    unmeasuredReason: 'not-fetched',
    ...overrides
  }
}

describe('buildUsageBarSegments', () => {
  it('keeps one segment per provider when accounts are not expanded', () => {
    const segments = buildUsageBarSegments({
      providers: [provider('claude'), provider('grok')],
      lanesByProvider: { claude: [lane(), lane({ accountId: 'account-2', ordinal: 2 })] },
      showAllAccounts: false
    })

    expect(segments.map((segment) => segment.key)).toEqual(['claude', 'grok'])
    expect(segments.every((segment) => segment.badge === null)).toBe(true)
  })

  it('gives every lane a unique key so sibling accounts can both render', () => {
    const segments = buildUsageBarSegments({
      providers: [provider('claude')],
      lanesByProvider: {
        claude: [
          lane({ kind: 'system-default', accountId: null, ordinal: 1, email: null }),
          lane({ accountId: 'account-2', ordinal: 2 })
        ]
      },
      showAllAccounts: true
    })

    expect(segments.map((segment) => segment.key)).toEqual([
      'claude:system-default',
      'claude:account-2'
    ])
  })

  it('carries the ordinal, email and active flag onto each badge', () => {
    const segments = buildUsageBarSegments({
      providers: [provider('codex')],
      lanesByProvider: {
        codex: [
          lane({ accountId: 'a', ordinal: 1, email: 'a@example.com', isActive: true }),
          lane({ accountId: 'b', ordinal: 2, email: 'b@example.com' })
        ]
      },
      showAllAccounts: true
    })

    expect(segments.map((segment) => segment.badge)).toEqual([
      { ordinal: 1, email: 'a@example.com', isActive: true },
      { ordinal: 2, email: 'b@example.com', isActive: false }
    ])
  })

  // Why: an older remote host omits the active-account field, so lanes are unknowable there.
  // Falling back to the single active meter beats inventing per-account numbers.
  it('falls back to the single meter when the host cannot report lanes', () => {
    const segments = buildUsageBarSegments({
      providers: [provider('claude')],
      lanesByProvider: { claude: null },
      showAllAccounts: true
    })

    expect(segments).toEqual([{ key: 'claude', limits: provider('claude'), badge: null }])
  })

  it('does not expand a provider that has only one lane', () => {
    const segments = buildUsageBarSegments({
      providers: [provider('claude')],
      lanesByProvider: { claude: [lane({ isActive: true, limits: provider('claude') })] },
      showAllAccounts: true
    })

    expect(segments.map((segment) => segment.key)).toEqual(['claude'])
    expect(segments[0]?.badge).toBeNull()
  })

  it('renders an unfetched lane as unavailable rather than zero', () => {
    const segments = buildUsageBarSegments({
      providers: [provider('claude', 55)],
      lanesByProvider: {
        claude: [
          lane({ accountId: 'a', ordinal: 1, isActive: true, limits: provider('claude', 55) }),
          lane({ accountId: 'b', ordinal: 2, unmeasuredReason: 'not-fetched' })
        ]
      },
      showAllAccounts: true
    })

    expect(segments[1]?.limits).toMatchObject({ status: 'unavailable', session: null })
    expect(segments[1]?.limits.session?.usedPercent).toBeUndefined()
  })

  it('renders a pending lane as fetching', () => {
    const segments = buildUsageBarSegments({
      providers: [provider('codex')],
      lanesByProvider: {
        codex: [
          lane({ accountId: 'a', ordinal: 1, isActive: true, limits: provider('codex') }),
          lane({ accountId: 'b', ordinal: 2, isFetching: true, unmeasuredReason: 'pending' })
        ]
      },
      showAllAccounts: true
    })

    expect(segments[1]?.limits.status).toBe('fetching')
  })
})
