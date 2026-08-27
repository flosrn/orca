// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values ? fallback.replace(/\{(\w+)\}/g, (_m, k) => values[k] ?? '') : fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null
}))

// The panel's rows are dropdown items; render them as plain nodes so the popover
// markup can be asserted without a Radix menu host.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    onSelect: _onSelect,
    ...props
  }: React.PropsWithChildren<{ onSelect?: () => void }>) => <div {...props}>{children}</div>
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { UsageRosterPanel } from './UsageRosterPanel'
import type { UsageBarSegment } from './usage-account-segments'
function claude(usedPercent: number | null): ProviderRateLimits {
  return {
    provider: 'claude',
    session:
      usedPercent === null
        ? null
        : { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: usedPercent === null ? 'unavailable' : 'ok'
  }
}

function render(segments: UsageBarSegment[]): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <UsageRosterPanel
        segments={segments}
        display="used"
        statusBarUsageMode="compact"
        onStatusBarUsageModeChange={() => {}}
        isRefreshing={false}
        onRefresh={() => {}}
        onOpenProvider={() => {}}
        onSignIn={() => {}}
        canSignIn={() => false}
        onManageAccounts={() => {}}
        onUsageDetails={() => {}}
      />
    </TooltipProvider>
  )
}

describe('UsageRosterPanel account rows', () => {
  // Why: the bar only has room for an ordinal. Without the identity in the popover there is no
  // surface anywhere that says whose quota a meter belongs to.
  it('names the account on every lane of a multi-account provider', () => {
    const markup = render([
      {
        key: 'claude:acc-1',
        limits: claude(41),
        badge: { ordinal: 1, email: 'goodluck.devv@gmail.com', isActive: true }
      },
      {
        key: 'claude:acc-2',
        limits: claude(87),
        badge: { ordinal: 2, email: 'florian.seran@gmail.com', isActive: false }
      }
    ])

    expect(markup).toContain('goodluck.devv@gmail.com')
    expect(markup).toContain('florian.seran@gmail.com')
    expect(markup).toContain('41%')
    expect(markup).toContain('87%')
  })

  it('falls back to the ordinal when the account has no resolved email', () => {
    const markup = render([
      { key: 'claude:sd', limits: claude(5), badge: { ordinal: 1, email: null, isActive: true } },
      {
        key: 'claude:acc-2',
        limits: claude(9),
        badge: { ordinal: 2, email: null, isActive: false }
      }
    ])

    expect(markup).toContain('account 1')
    expect(markup).toContain('account 2')
  })

  it('adds no account label for a single-account provider', () => {
    const markup = render([{ key: 'claude', limits: claude(41), badge: null }])

    expect(markup).not.toContain('account 1')
    expect(markup).not.toContain('@')
  })

  // Why: worst-first ordering must not reshuffle sibling lanes of one provider on every refresh.
  it('orders tied lanes by ordinal', () => {
    const markup = render([
      {
        key: 'claude:acc-2',
        limits: claude(50),
        badge: { ordinal: 2, email: 'b@x.com', isActive: false }
      },
      {
        key: 'claude:acc-1',
        limits: claude(50),
        badge: { ordinal: 1, email: 'a@x.com', isActive: true }
      }
    ])

    expect(markup.indexOf('a@x.com')).toBeLessThan(markup.indexOf('b@x.com'))
  })

  it('still renders an unmeasured lane as its own row', () => {
    const markup = render([
      {
        key: 'claude:acc-1',
        limits: claude(41),
        badge: { ordinal: 1, email: 'a@x.com', isActive: true }
      },
      {
        key: 'claude:acc-2',
        limits: claude(null),
        badge: { ordinal: 2, email: 'b@x.com', isActive: false }
      }
    ])

    expect(markup).toContain('a@x.com')
    expect(markup).toContain('b@x.com')
  })
})
