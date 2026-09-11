// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => values[k] ?? '') : fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    onSelect: _onSelect,
    ...props
  }: React.PropsWithChildren<{ onSelect?: () => void }>) => <div {...props}>{children}</div>
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { UsageRosterPanel } from './UsageRosterPanel'

const NOW = Date.parse('2026-09-11T12:00:00Z')

function window(overrides: Partial<RateLimitWindow> = {}): RateLimitWindow {
  return {
    usedPercent: 41,
    windowMinutes: 300,
    resetsAt: null,
    resetDescription: null,
    ...overrides
  }
}

function claude(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'ok',
    ...overrides
  }
}

function renderPanel(limits: ProviderRateLimits, canSignIn: boolean): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <UsageRosterPanel
        segments={[{ key: 'claude:acc-1', limits, badge: null }]}
        display="used"
        statusBarUsageMode="verbose"
        onStatusBarUsageModeChange={() => {}}
        isRefreshing={false}
        onRefresh={() => {}}
        onOpenProvider={() => {}}
        onSignIn={() => {}}
        canSignIn={() => canSignIn}
        onManageAccounts={() => {}}
        onUsageDetails={() => {}}
      />
    </TooltipProvider>
  )
}

function render(limits: ProviderRateLimits): string {
  return renderPanel(limits, false)
}

function renderWithSignIn(limits: ProviderRateLimits): string {
  return renderPanel(limits, true)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('UsageRosterPanel rows under a failed Claude refresh', () => {
  // Why: the whole point of retaining the previous sample is that the old number still helps.
  // It only helps if the row also says the number is old and the refresh failed.
  it('keeps the retained percentage and dates it next to the failure label', () => {
    const markup = render(
      claude({
        session: window({ usedPercent: 41, resetsAt: NOW + 2 * 3_600_000 }),
        status: 'error',
        error: 'Claude rate limited the usage refresh.',
        updatedAt: NOW - 12 * 60_000,
        usageMetadata: { failureKind: 'rate-limited' }
      })
    )

    expect(markup).toContain('41%')
    expect(markup).toContain('Refresh rate limited')
    expect(markup).toContain('last read 12m ago')
  })

  // Why: retention has a deadline; past it the windows are cleared and the row must admit it
  // has no reading at all rather than inventing one.
  it('admits it has no earlier reading when a retained sample is dated to nothing', () => {
    const markup = render(
      claude({
        session: window({ usedPercent: 41, resetsAt: NOW + 2 * 3_600_000 }),
        status: 'error',
        error: 'Claude rate limited the usage refresh.',
        updatedAt: 0,
        usageMetadata: { failureKind: 'rate-limited' }
      })
    )

    expect(markup).toContain('41%')
    expect(markup).toContain('Refresh rate limited')
    expect(markup).toContain('no earlier reading')
    expect(markup).not.toContain('last read')
  })

  it('shows no percentage at all when the windows were cleared', () => {
    const markup = render(
      claude({
        status: 'error',
        error: 'Claude rate limited the usage refresh.',
        updatedAt: 0,
        usageMetadata: { failureKind: 'rate-limited' }
      })
    )

    expect(markup).toContain('Refresh rate limited')
    expect(markup).not.toMatch(/>\d+%</)
  })

  // Why: the store overlays `status: 'fetching'` on the retained failed sample for the whole
  // retry round trip. Keying on status alone flipped the row back to a clean reading.
  it('stays stale while the retry is in flight over the retained sample', () => {
    const markup = render(
      claude({
        session: window({ usedPercent: 41, resetsAt: NOW + 2 * 3_600_000 }),
        status: 'fetching',
        error: 'Claude rate limited the usage refresh.',
        updatedAt: NOW - 12 * 60_000,
        usageMetadata: { failureKind: 'rate-limited' }
      })
    )

    expect(markup).toContain('41%')
    expect(markup).toContain('Refresh rate limited')
    expect(markup).toContain('last read 12m ago')
  })

  it('still withholds an expired window while the retry is in flight', () => {
    const markup = render(
      claude({
        session: window({ usedPercent: 63, resetsAt: NOW - 60_000 }),
        status: 'fetching',
        error: 'Claude rate limited the usage refresh.',
        updatedAt: NOW - 20 * 3_600_000,
        usageMetadata: { failureKind: 'rate-limited' }
      })
    )

    expect(markup).not.toContain('63%')
    expect(markup).toContain('—')
  })

  // Why: a lane whose credentials were revoked keeps its retained numbers, but the row must
  // still offer the way out.
  it('offers sign-in on a revoked lane that still shows retained numbers', () => {
    const markup = renderWithSignIn(
      claude({
        session: window({ usedPercent: 41, resetsAt: NOW + 2 * 3_600_000 }),
        status: 'error',
        error: 'Claude credentials are missing.',
        updatedAt: NOW - 3 * 3_600_000,
        usageMetadata: { failureKind: 'missing-credentials' }
      })
    )

    expect(markup).toContain('41%')
    expect(markup).toContain('not signed in')
    expect(markup).toContain('Sign in')
    expect(markup).toContain('last read 3h ago')
  })

  // Why: a retained window whose reset already passed measures a quota period that no longer
  // exists; printing its percentage would assert a fresh reading Orca does not have.
  it('withholds the number of a retained window whose reset already passed', () => {
    const markup = render(
      claude({
        session: window({ usedPercent: 41, resetsAt: NOW - 60_000 }),
        status: 'error',
        error: 'Claude rate limited the usage refresh.',
        updatedAt: NOW - 26 * 3_600_000,
        usageMetadata: { failureKind: 'rate-limited' }
      })
    )

    expect(markup).not.toContain('41%')
    expect(markup).toContain('—')
    expect(markup).toContain('Refresh rate limited')
  })

  it('leaves a healthy account reading exactly as it was', () => {
    const markup = render(
      claude({
        session: window({ usedPercent: 41, resetsAt: NOW + 2 * 3_600_000 }),
        status: 'ok',
        updatedAt: NOW - 12 * 60_000
      })
    )

    expect(markup).toContain('41%')
    expect(markup).not.toContain('Refresh rate limited')
    expect(markup).not.toContain('last read')
  })

  // Why: with per-account credentials, the deferral is about one account's credential rotation,
  // not about the user opening some Claude session somewhere.
  it('describes a deferred refresh as waiting for credentials, not as a chore for the user', () => {
    const markup = render(
      claude({
        status: 'error',
        error:
          'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.',
        updatedAt: 0,
        usageMetadata: {
          failureKind: 'deferred-by-live-session',
          deferredByLiveClaudeSession: true
        }
      })
    )

    expect(markup).toContain('Waiting for credential refresh')
    expect(markup).not.toContain('terminal')
  })
})
