import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' | 'remaining' }) => unknown) =>
    selector({ usagePercentageDisplay: 'used' })
}))

function claudeLimits(usedPercent: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

describe('ProviderSegment account badge', () => {
  it('labels a lane with its ordinal and discloses the email on hover', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      ProviderSegment({
        p: claudeLimits(42),
        compact: false,
        display: 'used',
        badge: { ordinal: 2, email: 'florian.seran@gmail.com', isActive: false }
      })
    )

    expect(markup).toContain('title="florian.seran@gmail.com"')
    expect(markup).toContain('<sup')
    expect(markup).toContain('>2</sup>')
    expect(markup).toContain('42%')
  })

  // Why: on a bar of identical provider icons the user still has to know which account the next
  // session will burn, so the active lane is emphasised rather than merely ordered.
  it('emphasises the active lane and dims the others', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const active = renderToStaticMarkup(
      ProviderSegment({
        p: claudeLimits(10),
        compact: false,
        display: 'used',
        badge: { ordinal: 1, email: 'a@example.com', isActive: true }
      })
    )
    const inactive = renderToStaticMarkup(
      ProviderSegment({
        p: claudeLimits(10),
        compact: false,
        display: 'used',
        badge: { ordinal: 2, email: 'b@example.com', isActive: false }
      })
    )

    expect(active).toContain('text-foreground')
    expect(inactive).toContain('text-muted-foreground/70')
  })

  it('renders no badge at all for a single-account provider', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      ProviderSegment({ p: claudeLimits(42), compact: false, display: 'used' })
    )

    expect(markup).not.toContain('<sup')
    expect(markup).not.toContain('title=')
  })

  // Why: an unfetched lane must read as unknown. A dash is honest; a percentage would not be.
  it('shows a dash rather than a percentage for an unmeasured lane', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      ProviderSegment({
        p: {
          provider: 'claude',
          session: null,
          weekly: null,
          updatedAt: 0,
          error: null,
          status: 'unavailable'
        },
        compact: false,
        display: 'used',
        badge: { ordinal: 3, email: 'c@example.com', isActive: false }
      })
    )

    expect(markup).toContain('--')
    expect(markup).not.toContain('%')
    expect(markup).toContain('>3</sup>')
  })
})
