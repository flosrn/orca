import { describe, expect, it } from 'vitest'
import {
  CODEXBAR_PROVIDER_CLI_ARGUMENT,
  CODEXBAR_PROVIDERS,
  mapCodexBarUsage
} from './codexbar-usage-mapper'

// Captured from `codexbar usage --provider cursor --format json` (CodexBar 0.55.0, 2026-08-27).
// Cursor reports three ~31-day slots plus a named side-pool, and no weekly window at all.
const CURSOR_PAYLOAD = JSON.stringify([
  {
    provider: 'cursor',
    source: 'web',
    usage: {
      loginMethod: 'Cursor Ultra',
      accountEmail: 'florian.seran@gmail.com',
      primary: {
        resetDescription: 'Resets Sep 12 at 11:11AM',
        usedPercent: 22.957142857142856,
        windowMinutes: 44640,
        resetsAt: '2026-09-12T04:11:45Z'
      },
      secondary: {
        resetDescription: 'Resets Sep 12 at 11:11AM',
        usedPercent: 23.188333333333333,
        windowMinutes: 44640,
        resetsAt: '2026-09-12T04:11:45Z'
      },
      tertiary: {
        resetDescription: 'Resets Sep 12 at 11:11AM',
        usedPercent: 21.57,
        windowMinutes: 44640,
        resetsAt: '2026-09-12T04:11:45Z'
      },
      extraRateWindows: [
        {
          id: 'cursor-grok-bot',
          title: 'Grok Bot',
          window: {
            windowMinutes: 9292,
            resetsAt: '2026-09-02T04:14:09Z',
            usedPercent: 10.935955,
            resetDescription: 'Resets Sep 2 at 11:14AM'
          }
        }
      ],
      updatedAt: '2026-08-27T11:35:21Z'
    }
  }
])

// ClinePass is the only one of the three that reports all three horizons at once.
const CLINEPASS_PAYLOAD = JSON.stringify([
  {
    source: 'api',
    provider: 'clinepass',
    usage: {
      loginMethod: 'API key',
      primary: { windowMinutes: 300, usedPercent: 96, resetsAt: '2026-08-27T12:24:48Z' },
      secondary: { windowMinutes: 10080, usedPercent: 38, resetsAt: '2026-08-30T12:46:22Z' },
      tertiary: { windowMinutes: 43200, usedPercent: 19, resetsAt: '2026-09-22T12:46:22Z' },
      updatedAt: '2026-08-27T11:35:19Z'
    }
  }
])

// Qwen Cloud reports a weekly slot only; primary and tertiary are explicitly null.
const QWENCLOUD_PAYLOAD = JSON.stringify([
  {
    source: 'web',
    provider: 'qwencloud',
    usage: {
      loginMethod: 'Standard',
      primary: null,
      secondary: {
        usedPercent: 90.32567932344,
        windowMinutes: 10080,
        resetsAt: '2026-08-31T10:29:00Z',
        resetDescription: '9,032.57 / 10,000 credits used'
      },
      tertiary: null,
      updatedAt: '2026-08-27T11:35:19Z'
    }
  }
])

describe('mapCodexBarUsage', () => {
  it('classifies windows by measured duration, not by slot name', () => {
    const { limits } = mapCodexBarUsage('clinepass', CLINEPASS_PAYLOAD)

    // `primary` is a 5h session here but a 31-day pool for Cursor, so the slot name decides nothing.
    expect(limits.session?.windowMinutes).toBe(300)
    expect(limits.session?.usedPercent).toBe(96)
    expect(limits.weekly?.windowMinutes).toBe(10080)
    expect(limits.weekly?.usedPercent).toBe(38)
    expect(limits.monthly?.windowMinutes).toBe(43200)
    expect(limits.status).toBe('ok')
    expect(limits.error).toBeNull()
  })

  it('parses ISO reset stamps into unix ms', () => {
    const { limits } = mapCodexBarUsage('qwencloud', QWENCLOUD_PAYLOAD)

    expect(limits.weekly?.resetsAt).toBe(Date.parse('2026-08-31T10:29:00Z'))
    expect(limits.weekly?.resetDescription).toBe('9,032.57 / 10,000 credits used')
  })

  it('keeps a weekly-only provider free of a phantom session window', () => {
    const { limits } = mapCodexBarUsage('qwencloud', QWENCLOUD_PAYLOAD)

    // A null slot is unknown usage, never 0% used.
    expect(limits.session).toBeNull()
    expect(limits.monthly).toBeUndefined()
    expect(limits.weekly?.usedPercent).toBe(90.32567932344)
  })

  it('collapses duplicate same-horizon slots to the highest used', () => {
    const { limits, email } = mapCodexBarUsage('cursor', CURSOR_PAYLOAD)

    // Cursor's three 31-day slots are one pool measured three ways; the pill must show the
    // binding one rather than an arbitrary slot.
    expect(limits.monthly?.usedPercent).toBeCloseTo(23.188, 3)
    expect(limits.weekly).toBeNull()
    expect(limits.session).toBeNull()
    expect(email).toBe('florian.seran@gmail.com')
  })

  it('carries Cursor side-pools as named buckets rather than extra accounts', () => {
    const { limits } = mapCodexBarUsage('cursor', CURSOR_PAYLOAD)

    expect(limits.buckets).toHaveLength(1)
    expect(limits.buckets?.[0]).toMatchObject({ name: 'Grok Bot', windowMinutes: 9292 })
  })

  it('reports the login method as the plan label', () => {
    expect(mapCodexBarUsage('cursor', CURSOR_PAYLOAD).limits.planType).toBe('Cursor Ultra')
  })

  it('maps a provider-level auth error to the CLI’s own message', () => {
    const raw = JSON.stringify([
      {
        provider: 'qwencloud',
        source: 'auto',
        error: { kind: 'provider', message: 'Qwen Cloud login required.', code: 1 }
      }
    ])

    const { limits } = mapCodexBarUsage('qwencloud', raw)

    expect(limits.status).toBe('error')
    expect(limits.error).toBe('Qwen Cloud login required.')
    expect(limits.usageMetadata?.failureKind).toBe('missing-credentials')
    // Never a fake zero: an unreadable provider has unknown usage.
    expect(limits.weekly).toBeNull()
    expect(limits.session).toBeNull()
  })

  it('treats non-JSON output as a parse failure instead of throwing', () => {
    const { limits } = mapCodexBarUsage('cursor', 'CodexBar 0.55.0\nnot json at all')

    expect(limits.status).toBe('error')
    expect(limits.usageMetadata?.failureKind).toBe('parse')
  })

  it('treats an unknown JSON shape as a parse failure', () => {
    const { limits } = mapCodexBarUsage('cursor', '{"provider":"cursor"}')

    expect(limits.status).toBe('error')
    expect(limits.usageMetadata?.failureKind).toBe('parse')
  })

  it('reports usage-unavailable when a window carries no percentage', () => {
    const raw = JSON.stringify([
      { provider: 'cursor', usage: { primary: { windowMinutes: 44640 }, tertiary: null } }
    ])

    const { limits } = mapCodexBarUsage('cursor', raw)

    expect(limits.status).toBe('error')
    expect(limits.usageMetadata?.failureKind).toBe('usage-unavailable')
  })

  it('drops an unparseable reset stamp instead of emitting NaN', () => {
    const raw = JSON.stringify([
      {
        provider: 'qwencloud',
        usage: { secondary: { usedPercent: 12, windowMinutes: 10080, resetsAt: 'never' } }
      }
    ])

    const { limits } = mapCodexBarUsage('qwencloud', raw)

    expect(limits.weekly?.resetsAt).toBeNull()
  })

  it('stamps every mapped provider with its own id', () => {
    for (const provider of CODEXBAR_PROVIDERS) {
      expect(mapCodexBarUsage(provider, '[]').limits.provider).toBe(provider)
    }
  })

  it('translates the Qwen Cloud id to the hyphenated CLI argument', () => {
    // CodexBar accepts `qwen-cloud` on the command line but reports `qwencloud` in the payload.
    expect(CODEXBAR_PROVIDER_CLI_ARGUMENT.qwencloud).toBe('qwen-cloud')
    expect(CODEXBAR_PROVIDER_CLI_ARGUMENT.cursor).toBe('cursor')
    expect(CODEXBAR_PROVIDER_CLI_ARGUMENT.clinepass).toBe('clinepass')
  })
})
