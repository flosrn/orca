import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import {
  buildManagedAccountUsageLanes,
  type ManagedAccountDescriptor,
  type ManagedAccountUsageLane
} from '../../../../shared/managed-account-usage-roster'

export type UsageAccountBadge = {
  /** 1-based label shown on the pill; the email is the hover disclosure. */
  ordinal: number
  email: string | null
  isActive: boolean
}

export type UsageBarSegment = {
  /** Unique across lanes — `provider` alone collides once one provider owns several accounts. */
  key: string
  limits: ProviderRateLimits
  badge: UsageAccountBadge | null
}

export type MultiAccountProvider = 'claude' | 'codex'

export type BuildUsageBarSegmentsArgs = {
  /** Visibility-filtered providers, already in display order. */
  providers: readonly ProviderRateLimits[]
  /**
   * Lanes per provider. `null` means this host cannot say which account is active — an older
   * remote host omits the field — and the provider then keeps its single active meter.
   */
  lanesByProvider: Partial<Record<MultiAccountProvider, ManagedAccountUsageLane[] | null>>
  showAllAccounts: boolean
}

export function buildUsageBarSegments(args: BuildUsageBarSegmentsArgs): UsageBarSegment[] {
  const segments: UsageBarSegment[] = []
  for (const provider of args.providers) {
    const lanes = args.lanesByProvider[provider.provider as MultiAccountProvider]
    if (!args.showAllAccounts || !lanes || lanes.length < 2) {
      segments.push({ key: provider.provider, limits: provider, badge: null })
      continue
    }
    for (const lane of lanes) {
      segments.push({
        key: `${provider.provider}:${lane.accountId ?? 'system-default'}`,
        limits: lane.limits ?? unmeasuredLimits(provider.provider, lane),
        badge: { ordinal: lane.ordinal, email: lane.email, isActive: lane.isActive }
      })
    }
  }
  return segments
}

export type StatusBarAccountLaneSource = {
  activeAccountId: string | null | undefined
  systemDefault: RateLimitState['claudeSystemDefault']
  managedAccounts: readonly ManagedAccountDescriptor[]
  activeLimits: ProviderRateLimits | null
  providerLimits: ProviderRateLimits | null
  inactive: RateLimitState['inactiveClaudeAccounts']
}

/**
 * Expands Claude/Codex into per-account meters. A remote owner or an older host
 * that omits the active-account field keeps the single provider meter.
 */
export function buildStatusBarUsageBarSegments(args: {
  providers: readonly ProviderRateLimits[]
  hideAccountRoster: boolean
  claude: StatusBarAccountLaneSource | null
  codex: StatusBarAccountLaneSource | null
}): UsageBarSegment[] {
  return buildUsageBarSegments({
    providers: args.providers,
    lanesByProvider: {
      ...(args.claude ? { claude: lanesForSource(args.hideAccountRoster, args.claude) } : {}),
      ...(args.codex ? { codex: lanesForSource(args.hideAccountRoster, args.codex) } : {})
    },
    showAllAccounts: true
  })
}

function lanesForSource(
  hideAccountRoster: boolean,
  source: StatusBarAccountLaneSource
): ManagedAccountUsageLane[] | null {
  if (hideAccountRoster || source.activeAccountId === undefined) {
    return null
  }
  return buildManagedAccountUsageLanes({
    systemDefault: source.systemDefault ?? null,
    managedAccounts: source.managedAccounts,
    activeAccountId: source.activeAccountId,
    activeLimits: source.activeLimits,
    inactive: source.providerLimits === null ? [] : source.inactive
  })
}

/**
 * Stands in for a lane with no measurement of its own. `unavailable` renders a dimmed dash
 * rather than a percentage: an unfetched account's usage is unknown, never zero.
 */
function unmeasuredLimits(
  provider: ProviderRateLimits['provider'],
  lane: ManagedAccountUsageLane
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: lane.unmeasuredReason === 'pending' ? 'fetching' : 'unavailable'
  }
}
