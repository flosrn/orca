import { AlertTriangle } from 'lucide-react'
import React from 'react'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { ProviderIcon, clampUsedPercent, getProviderUsageStatusLabel } from './tooltip'
import { getStatusBarUsageSection } from './UsageRosterPanel'
import { isProviderRefreshFailing, isUsageWindowExpired } from './usage-stale-sample'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { formatRateLimitWindowChipLabel } from '@/lib/window-label-formatter'
import { formatUsagePercentageLabel } from './usage-percentage-label'
import { translate } from '@/i18n/i18n'
import type { UsageAccountBadge } from './usage-account-segments'

function MiniBar({
  usedPct,
  display
}: {
  usedPct: number
  display: UsagePercentageDisplay
}): React.JSX.Element {
  return (
    <div
      data-usage-bar
      className="w-[48px] h-[6px] rounded-full bg-muted overflow-hidden flex-shrink-0"
    >
      <div
        className="h-full rounded-full transition-all duration-300 bg-muted-foreground/40"
        style={{ width: `${getDisplayedUsagePercentage(usedPct, display)}%` }}
      />
    </div>
  )
}

function WindowLabel({
  w,
  label,
  display,
  showLabel = true,
  expired = false
}: {
  w: RateLimitWindow
  label: string
  display: UsagePercentageDisplay
  showLabel?: boolean
  expired?: boolean
}): React.JSX.Element {
  return (
    <span className="whitespace-nowrap tabular-nums">
      {expired ? '—' : formatUsagePercentageLabel(w.usedPercent, display)}
      {showLabel ? ` ${label}` : ''}
    </span>
  )
}

// Single-letter provider badge for the icon-only (narrow) status bar. Shared by
// the roster trigger and ProviderDetailsMenu so the dot's has-data condition
// and markup can't drift between the two.
export function ProviderLetterBadge({ p }: { p: ProviderRateLimits }): React.JSX.Element {
  const hasData = Boolean(p.session || p.weekly || p.fableWeekly || p.monthly || p.buckets?.length)
  // The dot is the whole message at this width, so a lane whose refresh is failing must not
  // wear the same solid dot as one that just refreshed.
  const dotClass = isProviderRefreshFailing(p)
    ? 'bg-amber-500/70'
    : hasData
      ? 'bg-muted-foreground/60'
      : 'bg-muted-foreground/30'
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
      {getProviderLetter(p.provider)}
    </span>
  )
}

function getProviderLetter(provider: ProviderRateLimits['provider']): string {
  switch (provider) {
    case 'claude':
      return 'C'
    case 'gemini':
      return 'G'
    case 'opencode-go':
      return 'O'
    case 'kimi':
      return 'K'
    case 'antigravity':
      return 'A'
    case 'minimax':
      return 'M'
    case 'grok':
      return 'R'
    case 'codex':
      return 'X'
    case 'cursor':
      return 'U'
    case 'clinepass':
      return 'P'
    case 'qwencloud':
      return 'Q'
  }
}

// ---------------------------------------------------------------------------
// Provider segment
// ---------------------------------------------------------------------------

// Why: Gemini exposes extra experimental buckets that made the pre-existing verbose footer noisy.
const STATUS_BAR_BUCKET_NAMES = new Set(['Flash', 'Pro', '1.5 Pro'])

function VerboseProviderUsage({
  p,
  display,
  now
}: {
  p: ProviderRateLimits
  display: UsagePercentageDisplay
  now: number
}): React.JSX.Element {
  if (p.buckets && p.buckets.length > 0) {
    const visibleBuckets = p.buckets.filter((bucket) => STATUS_BAR_BUCKET_NAMES.has(bucket.name))
    return (
      <>
        {visibleBuckets.map((bucket, index) => (
          <React.Fragment key={bucket.name}>
            {index > 0 ? <span className="text-muted-foreground">·</span> : null}
            <span className="whitespace-nowrap tabular-nums">
              {bucket.name}{' '}
              {isUsageWindowExpired(bucket, now)
                ? '—'
                : formatUsagePercentageLabel(bucket.usedPercent, display)}
            </span>
          </React.Fragment>
        ))}
        {visibleBuckets.length === 0 && p.session ? (
          <WindowLabel
            w={p.session}
            label={formatRateLimitWindowChipLabel(p.session)}
            display={display}
            expired={isUsageWindowExpired(p.session, now)}
          />
        ) : null}
      </>
    )
  }

  const visibleWindows = [
    p.session
      ? {
          key: 'session',
          window: p.session,
          label: formatRateLimitWindowChipLabel(p.session)
        }
      : null,
    p.weekly
      ? {
          key: 'weekly',
          window: p.weekly,
          label: formatRateLimitWindowChipLabel(p.weekly)
        }
      : null,
    p.fableWeekly
      ? {
          key: 'fableWeekly',
          window: p.fableWeekly,
          label: translate('auto.components.status.bar.StatusBar.a79c64f87e', 'Fable')
        }
      : null,
    // Why: monthly stays inline for monthly-only providers; otherwise the detail panel carries it.
    p.monthly && !p.session && !p.weekly
      ? {
          key: 'monthly',
          window: p.monthly,
          label: formatRateLimitWindowChipLabel(p.monthly)
        }
      : null
  ].filter((window): window is { key: string; window: RateLimitWindow; label: string } => {
    return window !== null
  })

  return (
    <>
      {visibleWindows.map((window, index) => (
        <React.Fragment key={window.key}>
          {index > 0 ? <span className="text-muted-foreground">·</span> : null}
          <WindowLabel
            w={window.window}
            label={window.label}
            display={display}
            expired={isUsageWindowExpired(window.window, now)}
          />
        </React.Fragment>
      ))}
    </>
  )
}

function ProviderAccountMark({
  provider,
  badge
}: {
  provider: ProviderRateLimits['provider']
  badge: UsageAccountBadge | null
}): React.JSX.Element {
  if (!badge) {
    return <ProviderIcon provider={provider} />
  }
  return (
    <span
      className="inline-flex items-center gap-1"
      title={badge.email ?? undefined}
      aria-label={badge.email ?? `${provider} ${badge.ordinal}`}
    >
      <ProviderIcon provider={provider} />
      <span
        className={
          badge.isActive
            ? 'text-[10px] font-semibold leading-none tabular-nums text-foreground/90'
            : 'text-[10px] font-medium leading-none tabular-nums text-muted-foreground/60'
        }
      >
        {badge.ordinal}
      </span>
    </span>
  )
}

export function ProviderSegment({
  p,
  compact,
  display,
  mode = 'verbose',
  badge = null
}: {
  p: ProviderRateLimits | null
  compact: boolean
  display: UsagePercentageDisplay
  mode?: StatusBarUsageMode
  badge?: UsageAccountBadge | null
}): React.JSX.Element {
  const provider = p?.provider ?? 'claude'
  // Hooks run before the early returns below; the bar is always mounted, so without a
  // boundary-scheduled clock an expired window would keep printing its old percentage
  // until some unrelated provider push happened to re-render the surface.
  const now = useResetCountdownClock([
    p?.session?.resetsAt,
    p?.weekly?.resetsAt,
    p?.fableWeekly?.resetsAt,
    p?.monthly?.resetsAt,
    ...(p?.buckets ?? []).map((bucket) => bucket.resetsAt)
  ])
  const mark = <ProviderAccountMark provider={provider} badge={badge} />
  const statusLabel = p ? getProviderUsageStatusLabel(p) : ''

  // Idle / initial load
  if (!p || p.status === 'idle') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">
        {mark}
        <span className="animate-pulse">···</span>
      </span>
    )
  }

  const summary = getStatusBarUsageSection(p)

  // Fetching with no prior data
  if (p.status === 'fetching' && !summary) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">
        {mark}
        <span className="animate-pulse">···</span>
      </span>
    )
  }

  // Unavailable (CLI not installed)
  if (p.status === 'unavailable') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground/50">
        {mark} --
      </span>
    )
  }

  // Error with no data
  if (p.status === 'error' && !summary) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">
        {mark}
        <AlertTriangle size={11} className="shrink-0 text-muted-foreground/80" />
        {!compact && (
          // Why: this copy is a localized sentence ("En attente du renouvellement des
          // identifiants"), while the bar is a single 24px row shared by every lane. Bound it
          // tightly so a dense French roster still fits; the hover title and the Usage popover
          // row keep the sentence in full.
          <span
            className="min-w-0 max-w-[72px] truncate text-[11px] font-medium"
            title={statusLabel}
          >
            {statusLabel}
          </span>
        )}
      </span>
    )
  }

  // Has data (ok, fetching with retained data, or error with retained data)
  const isStale = isProviderRefreshFailing(p)
  const summaryExpired = Boolean(summary && isUsageWindowExpired(summary.window, now))

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {mark}
      {mode === 'verbose' ? (
        <>
          {summary && !compact && !summaryExpired ? (
            <MiniBar usedPct={clampUsedPercent(summary.window.usedPercent)} display={display} />
          ) : null}
          <VerboseProviderUsage p={p} display={display} now={now} />
        </>
      ) : summary ? (
        <WindowLabel
          w={summary.window}
          label={summary.label}
          display={display}
          showLabel={!compact}
          expired={summaryExpired}
        />
      ) : null}
      {isStale && <AlertTriangle size={11} className="shrink-0 text-muted-foreground/80" />}
    </span>
  )
}
