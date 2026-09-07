import { describe, expect, it } from 'vitest'
import {
  SYSTEM_DEFAULT_ACCOUNT_ID,
  buildManagedAccountUsageLanes,
  isCoveredByManagedAccount,
  type BuildManagedAccountUsageLanesArgs
} from './managed-account-usage-roster'
import type { InactiveAccountUsage, ProviderRateLimits } from './rate-limit-types'

function limits(
  usedPercent: number | null,
  status: ProviderRateLimits['status'] = 'ok'
): ProviderRateLimits {
  return {
    provider: 'claude',
    session:
      usedPercent === null
        ? null
        : { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status
  }
}

function inactive(
  accountId: string,
  overrides: Partial<InactiveAccountUsage> = {}
): InactiveAccountUsage {
  return { accountId, rateLimits: null, updatedAt: 0, isFetching: false, ...overrides }
}

function args(
  overrides: Partial<BuildManagedAccountUsageLanesArgs> = {}
): BuildManagedAccountUsageLanesArgs {
  return {
    systemDefault: { email: 'system@example.com', measurableWhenInactive: true },
    managedAccounts: [
      { id: 'account-late', email: 'late@example.com', createdAt: 200 },
      { id: 'account-early', email: 'early@example.com', createdAt: 100 }
    ],
    activeAccountId: 'account-early',
    activeLimits: limits(42),
    inactive: [],
    ...overrides
  }
}

describe('buildManagedAccountUsageLanes', () => {
  // Why: the regression this builder exists for — before the first inactive fetch the cache is
  // empty, and inferring "active" by absence reported the active account's usage on every lane.
  it('leaves uncached lanes unmeasured instead of reusing the active account usage', () => {
    const lanes = buildManagedAccountUsageLanes(args({ inactive: [] }))

    expect(
      lanes.map((lane) => [lane.accountId, lane.limits?.session?.usedPercent ?? null])
    ).toEqual([
      [null, null],
      ['account-early', 42],
      ['account-late', null]
    ])
    expect(lanes.filter((lane) => !lane.isActive).map((lane) => lane.unmeasuredReason)).toEqual([
      'not-fetched',
      'not-fetched'
    ])
  })

  it('keeps the system-default lane and orders managed accounts by creation', () => {
    const lanes = buildManagedAccountUsageLanes(args())

    expect(lanes.map((lane) => [lane.ordinal, lane.kind, lane.accountId, lane.email])).toEqual([
      [1, 'system-default', null, 'system@example.com'],
      [2, 'managed', 'account-early', 'early@example.com'],
      [3, 'managed', 'account-late', 'late@example.com']
    ])
  })

  // Why: an absent/signed-out/API-key login has no usage window; a lane for it would be a
  // phantom account. Email is not the presence signal — Claude's own default reports none.
  it('omits the system-default lane when the provider has no such login', () => {
    const lanes = buildManagedAccountUsageLanes(args({ systemDefault: null }))

    expect(lanes.map((lane) => [lane.ordinal, lane.kind, lane.accountId])).toEqual([
      [1, 'managed', 'account-early'],
      [2, 'managed', 'account-late']
    ])
  })

  it('keeps a present system default whose identity is unresolved', () => {
    const lanes = buildManagedAccountUsageLanes(
      args({ systemDefault: { email: null, measurableWhenInactive: true } })
    )

    expect(lanes[0]).toMatchObject({ kind: 'system-default', email: null, ordinal: 1 })
  })

  // Why: ordinals are a user-facing label; switching accounts must not renumber the pills.
  it('keeps ordinals stable when the active account changes', () => {
    const before = buildManagedAccountUsageLanes(args({ activeAccountId: 'account-early' }))
    const after = buildManagedAccountUsageLanes(args({ activeAccountId: 'account-late' }))

    expect(after.map((lane) => [lane.ordinal, lane.accountId])).toEqual(
      before.map((lane) => [lane.ordinal, lane.accountId])
    )
    expect(after.find((lane) => lane.isActive)?.accountId).toBe('account-late')
  })

  it('marks the system default active when no managed account is selected', () => {
    const lanes = buildManagedAccountUsageLanes(
      args({ activeAccountId: null, activeLimits: limits(7) })
    )

    expect(lanes[0]).toMatchObject({ accountId: null, isActive: true, unmeasuredReason: null })
    expect(lanes[0]?.limits?.session?.usedPercent).toBe(7)
    expect(lanes.slice(1).every((lane) => lane.limits === null)).toBe(true)
  })

  it('reads an inactive lane from its own cached result', () => {
    const lanes = buildManagedAccountUsageLanes(
      args({ inactive: [inactive('account-late', { rateLimits: limits(88) })] })
    )

    expect(lanes[2]).toMatchObject({ accountId: 'account-late', isActive: false })
    expect(lanes[2]?.limits?.session?.usedPercent).toBe(88)
    expect(lanes[2]?.unmeasuredReason).toBeNull()
  })

  it('distinguishes a pending fetch from a lane nothing has fetched', () => {
    const lanes = buildManagedAccountUsageLanes(
      args({ inactive: [inactive('account-late', { isFetching: true })] })
    )

    expect(lanes[2]).toMatchObject({ isFetching: true, unmeasuredReason: 'pending' })
    expect(lanes[0]).toMatchObject({ isFetching: false, unmeasuredReason: 'not-fetched' })
  })

  it('resolves the system-default lane through its sentinel id', () => {
    const lanes = buildManagedAccountUsageLanes(
      args({ inactive: [inactive(SYSTEM_DEFAULT_ACCOUNT_ID, { rateLimits: limits(11) })] })
    )

    expect(lanes[0]?.limits?.session?.usedPercent).toBe(11)
  })

  it('ignores a cached result for a system default it cannot measure while inactive', () => {
    const lanes = buildManagedAccountUsageLanes(
      args({
        systemDefault: { email: 'system@example.com', measurableWhenInactive: false },
        inactive: [inactive(SYSTEM_DEFAULT_ACCOUNT_ID, { rateLimits: limits(11) })]
      })
    )

    expect(lanes[0]).toMatchObject({ limits: null, unmeasuredReason: 'not-fetched' })
  })

  it('treats an active snapshot with no window as pending rather than measured', () => {
    const lanes = buildManagedAccountUsageLanes(args({ activeLimits: limits(null, 'fetching') }))

    expect(lanes[1]).toMatchObject({
      isActive: true,
      isFetching: true,
      unmeasuredReason: 'pending'
    })
  })
})

describe('isCoveredByManagedAccount', () => {
  // Why: signing the system-default identity in as a managed account leaves ~/.codex pointing
  // at it too. Publishing both lanes metered one subscription twice and showed a third account
  // the user never created.
  it('matches a managed account with the same identity, case and space insensitively', () => {
    expect(isCoveredByManagedAccount('Flo@Example.com ', [{ email: 'flo@example.com' }])).toBe(true)
  })

  it('does not match a different identity', () => {
    expect(isCoveredByManagedAccount('a@example.com', [{ email: 'b@example.com' }])).toBe(false)
  })

  // Why: an unresolved identity cannot be proven to duplicate anything, so the lane stays.
  it('treats an unresolved or blank identity as uncovered', () => {
    expect(isCoveredByManagedAccount(null, [{ email: 'a@example.com' }])).toBe(false)
    expect(isCoveredByManagedAccount('   ', [{ email: 'a@example.com' }])).toBe(false)
  })

  it('is false with no managed accounts', () => {
    expect(isCoveredByManagedAccount('a@example.com', [])).toBe(false)
  })
})
