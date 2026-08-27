import { describe, expect, it } from 'vitest'
import {
  buildStatusBarUsageBarSegments,
  buildUsageBarSegments,
  type StatusBarAccountLaneSource
} from './usage-account-segments'
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

describe('buildStatusBarUsageBarSegments', () => {
  function source(overrides: Partial<StatusBarAccountLaneSource> = {}): StatusBarAccountLaneSource {
    return {
      activeAccountId: 'account-1',
      systemDefault: null,
      managedAccounts: [
        { id: 'account-1', email: 'a@x.com', createdAt: 1 },
        { id: 'account-2', email: 'b@x.com', createdAt: 2 }
      ],
      activeLimits: provider('claude', 41),
      providerLimits: provider('claude', 41),
      inactive: [
        {
          accountId: 'account-2',
          rateLimits: provider('claude', 87),
          updatedAt: 1,
          isFetching: false
        }
      ],
      ...overrides
    }
  }

  it('expands Claude into one segment per managed account', () => {
    const segments = buildStatusBarUsageBarSegments({
      providers: [provider('claude', 41)],
      hideAccountRoster: false,
      claude: source(),
      codex: null
    })

    expect(segments.map((segment) => segment.key)).toEqual(['claude:account-1', 'claude:account-2'])
    expect(segments.map((segment) => segment.limits.session?.usedPercent)).toEqual([41, 87])
  })

  it('expands Codex independently of Claude', () => {
    const segments = buildStatusBarUsageBarSegments({
      providers: [provider('claude', 41), provider('codex', 20)],
      hideAccountRoster: false,
      claude: source(),
      codex: source({
        activeLimits: provider('codex', 20),
        providerLimits: provider('codex', 20),
        inactive: [
          {
            accountId: 'account-2',
            rateLimits: provider('codex', 55),
            updatedAt: 1,
            isFetching: false
          }
        ]
      })
    })

    expect(segments.map((segment) => segment.key)).toEqual([
      'claude:account-1',
      'claude:account-2',
      'codex:account-1',
      'codex:account-2'
    ])
  })
  it('keeps a single meter when a remote owner hides the local roster', () => {
    const segments = buildStatusBarUsageBarSegments({
      providers: [provider('claude', 41)],
      hideAccountRoster: true,
      claude: source(),
      codex: null
    })

    expect(segments.map((segment) => segment.key)).toEqual(['claude'])
  })

  it('keeps a single meter when the host omits the active-account field', () => {
    const segments = buildStatusBarUsageBarSegments({
      providers: [provider('claude', 41)],
      hideAccountRoster: false,
      claude: source({ activeAccountId: undefined }),
      codex: null
    })

    expect(segments.map((segment) => segment.key)).toEqual(['claude'])
  })
})
