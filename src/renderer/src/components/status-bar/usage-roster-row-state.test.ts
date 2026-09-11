import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { getUsageRosterRowState } from './usage-roster-row-state'

function provider(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
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

describe('getUsageRosterRowState', () => {
  it('keeps fetching providers in a loading state instead of calling them signed out', () => {
    expect(getUsageRosterRowState(provider({ status: 'fetching' }), false)).toEqual({
      kind: 'loading',
      statusLabel: 'Loading usage…'
    })
  })

  it('preserves transient Claude failure copy instead of offering sign-in', () => {
    expect(
      getUsageRosterRowState(
        provider({
          status: 'error',
          error: 'OAuth token is stale',
          usageMetadata: { failureKind: 'stale-token' }
        }),
        false
      )
    ).toEqual({ kind: 'error', statusLabel: 'Refreshing sign-in' })
    expect(
      getUsageRosterRowState(
        provider({
          status: 'error',
          error: 'network unavailable',
          usageMetadata: { failureKind: 'network' }
        }),
        false
      )
    ).toEqual({ kind: 'error', statusLabel: 'Network issue' })
  })

  it('offers sign-in only for confirmed signed-out failures', () => {
    expect(
      getUsageRosterRowState(
        provider({ status: 'error', usageMetadata: { failureKind: 'missing-credentials' } }),
        false
      )
    ).toEqual({ kind: 'sign-in', statusLabel: 'not signed in' })
    expect(
      getUsageRosterRowState(
        provider({
          provider: 'codex',
          status: 'error',
          error: 'ChatGPT authentication required to read rate limits'
        }),
        false
      )
    ).toEqual({ kind: 'sign-in', statusLabel: 'not signed in' })
  })

  it('does not turn an expired CLI-owned Kimi token into a sign-in action', () => {
    expect(
      getUsageRosterRowState(
        provider({
          provider: 'kimi',
          status: 'error',
          error: 'Kimi token expired — open Kimi to refresh'
        }),
        false
      )
    ).toEqual({ kind: 'error', statusLabel: 'Refresh failed' })
  })

  it('distinguishes unavailable and empty successful responses', () => {
    expect(
      getUsageRosterRowState(
        provider({ status: 'unavailable', error: 'Claude CLI not found' }),
        false
      )
    ).toEqual({ kind: 'unavailable', statusLabel: 'Usage unavailable' })
    expect(getUsageRosterRowState(provider(), false)).toEqual({
      kind: 'empty',
      statusLabel: 'No usage data'
    })
  })

  // Why: retained numbers from the last successful capture are still worth showing, but a row
  // that shows them while the refresh is failing must say so — silently rendering them as a
  // healthy reading is the dishonest case this replaces.
  it('keeps retained usage visible but labels it as a failed refresh', () => {
    expect(
      getUsageRosterRowState(
        provider({ status: 'error', usageMetadata: { failureKind: 'rate-limited' } }),
        true
      )
    ).toEqual({ kind: 'stale-usage', statusLabel: 'Refresh rate limited' })
  })

  it('reports fresh data with no status label', () => {
    expect(getUsageRosterRowState(provider({ status: 'ok' }), true)).toEqual({
      kind: 'usage',
      statusLabel: null
    })
  })

  it('does not label a plain refetch over existing data as stale', () => {
    expect(getUsageRosterRowState(provider({ status: 'fetching', error: null }), true)).toEqual({
      kind: 'usage',
      statusLabel: null
    })
  })

  // Why: the store overlays `status: 'fetching'` on the failed sample while the retry is in
  // flight, keeping its error and windows. Keying staleness on status alone made the row flip
  // back to a clean reading for the whole round trip.
  it('stays stale while a retry runs over a retained failed sample', () => {
    expect(
      getUsageRosterRowState(
        provider({
          status: 'fetching',
          error: 'HTTP 429 from the Claude usage endpoint',
          usageMetadata: { failureKind: 'rate-limited' }
        }),
        true
      )
    ).toEqual({ kind: 'stale-usage', statusLabel: 'Refresh rate limited' })
  })

  // Why: a revoked lane that still has yesterday's numbers needs the sign-in route, not just
  // a failure label it cannot act on.
  it('keeps the sign-in route for a revoked lane that still has retained numbers', () => {
    expect(
      getUsageRosterRowState(
        provider({ status: 'error', usageMetadata: { failureKind: 'missing-credentials' } }),
        true
      )
    ).toEqual({ kind: 'sign-in', statusLabel: 'not signed in' })
  })
})
