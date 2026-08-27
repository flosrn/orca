import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  SystemDefaultLaneDescriptor
} from './rate-limit-types'

/** Sentinel id for the provider's own login (real ~/.claude / ~/.codex), which has no managed-account row. */
export const SYSTEM_DEFAULT_ACCOUNT_ID = '__system-default__'

export type ManagedAccountDescriptor = {
  id: string
  email: string
  createdAt: number
}

/** Why a lane has no numbers, so the UI explains instead of rendering a blank meter. */
export type UnmeasuredLaneReason =
  /** A fetch is in flight and has not produced a window yet. */
  | 'pending'
  /** Nothing has fetched this lane; its usage is unknown, not zero. */
  | 'not-fetched'

export type ManagedAccountUsageLane = {
  kind: 'system-default' | 'managed'
  /** Managed account id, or null for the system-default login. */
  accountId: string | null
  /**
   * 1-based label across the provider's present lanes, system default first.
   * Stable while accounts are switched; a login appearing or disappearing renumbers.
   */
  ordinal: number
  email: string | null
  isActive: boolean
  /** Null unless this lane has its own measurement — never a stand-in from another lane. */
  limits: ProviderRateLimits | null
  isFetching: boolean
  unmeasuredReason: UnmeasuredLaneReason | null
}

export type BuildManagedAccountUsageLanesArgs = {
  systemDefault: SystemDefaultLaneDescriptor | null
  managedAccounts: readonly ManagedAccountDescriptor[]
  /** Null selects the system default. */
  activeAccountId: string | null
  /** Usage for whichever lane is active; the service fetches exactly one active lane. */
  activeLimits: ProviderRateLimits | null
  inactive: readonly InactiveAccountUsage[]
}

/**
 * Orders every account of one provider into display lanes.
 *
 * Why a builder rather than a render-time lookup: a lane with no cached result must stay
 * visibly unmeasured. Deriving "active" by absence from the inactive array instead reports
 * the active account's numbers on every lane before the first inactive fetch resolves.
 */
export function buildManagedAccountUsageLanes(
  args: BuildManagedAccountUsageLanesArgs
): ManagedAccountUsageLane[] {
  const ordered = [...args.managedAccounts].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  )
  const lanes: ManagedAccountUsageLane[] = []
  if (args.systemDefault) {
    lanes.push(
      buildLane({
        kind: 'system-default',
        accountId: null,
        email: args.systemDefault.email,
        measurableWhenInactive: args.systemDefault.measurableWhenInactive,
        ordinal: 1,
        args
      })
    )
  }
  for (const account of ordered) {
    lanes.push(
      buildLane({
        kind: 'managed',
        accountId: account.id,
        email: account.email,
        measurableWhenInactive: true,
        ordinal: lanes.length + 1,
        args
      })
    )
  }
  return lanes
}

function buildLane(input: {
  kind: ManagedAccountUsageLane['kind']
  accountId: string | null
  email: string | null
  measurableWhenInactive: boolean
  ordinal: number
  args: BuildManagedAccountUsageLanesArgs
}): ManagedAccountUsageLane {
  const { kind, accountId, email, measurableWhenInactive, ordinal, args } = input
  const isActive = accountId === args.activeAccountId
  const base = { kind, accountId, ordinal, email, isActive }

  if (isActive) {
    const limits = args.activeLimits
    return {
      ...base,
      limits,
      isFetching: limits?.status === 'fetching',
      unmeasuredReason: hasMeasurement(limits) ? null : limits ? 'pending' : 'not-fetched'
    }
  }

  if (!measurableWhenInactive) {
    return { ...base, limits: null, isFetching: false, unmeasuredReason: 'not-fetched' }
  }

  const entry = args.inactive.find(
    (candidate) => candidate.accountId === (accountId ?? SYSTEM_DEFAULT_ACCOUNT_ID)
  )
  if (!entry) {
    return { ...base, limits: null, isFetching: false, unmeasuredReason: 'not-fetched' }
  }
  return {
    ...base,
    limits: entry.rateLimits,
    isFetching: entry.isFetching,
    unmeasuredReason: hasMeasurement(entry.rateLimits)
      ? null
      : entry.isFetching
        ? 'pending'
        : 'not-fetched'
  }
}

function hasMeasurement(limits: ProviderRateLimits | null): boolean {
  if (!limits) {
    return false
  }
  return Boolean(
    limits.session ||
    limits.weekly ||
    limits.monthly ||
    limits.fableWeekly ||
    (limits.buckets?.length ?? 0) > 0
  )
}
