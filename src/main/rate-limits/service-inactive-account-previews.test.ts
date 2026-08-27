import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits, fetchManagedAccountUsage } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import {
  deferred,
  errorProvider,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

function inactiveCodexAccount(id: string, managedHomePath: string) {
  return {
    id,
    resolveHome: () => ({ kind: 'ready' as const, managedHomePath })
  }
}

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
}))

vi.mock('./minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

describe('RateLimitService', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
  })

  it('aborts inactive Claude preview fetches on stop', async () => {
    const service = new RateLimitService()
    const account = { id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }
    const capturedSignals: { claude?: AbortSignal } = {}
    service.setInactiveClaudeAccountsResolver(() => [account])
    vi.mocked(fetchManagedAccountUsage).mockImplementation(
      (_account, options) =>
        new Promise((resolve) => {
          capturedSignals.claude = options?.signal
          options?.signal?.addEventListener(
            'abort',
            () => resolve(errorProvider('claude', 'aborted')),
            { once: true }
          )
        })
    )

    const previewFetch = service.fetchInactiveClaudeAccounts()
    await Promise.resolve()

    service.stop()

    expect(capturedSignals.claude?.aborted).toBe(true)

    await previewFetch

    expect(service.getState().inactiveClaudeAccounts).toEqual([])
  })

  it('aborts inactive Codex preview fetches on stop', async () => {
    const service = new RateLimitService()
    const account = inactiveCodexAccount('account-1', '/tmp/account-1/home')
    const capturedSignals: { codex?: AbortSignal } = {}
    service.setInactiveCodexAccountsResolver(() => [account])
    vi.mocked(fetchCodexRateLimits).mockImplementation(
      (options) =>
        new Promise((resolve) => {
          capturedSignals.codex = options?.signal
          options?.signal?.addEventListener(
            'abort',
            () => resolve(errorProvider('codex', 'aborted')),
            { once: true }
          )
        })
    )

    const previewFetch = service.fetchInactiveCodexAccounts()
    await Promise.resolve()

    service.stop()

    expect(capturedSignals.codex?.aborted).toBe(true)

    await previewFetch

    expect(service.getState().inactiveCodexAccounts).toEqual([])
  })

  it('passes WSL Codex managed homes into inactive account rate-limit fetches', async () => {
    const service = new RateLimitService()
    const wslCodexHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
    service.setInactiveCodexAccountsResolver(() => [
      inactiveCodexAccount('account-1', wslCodexHome)
    ])
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 33, Date.now()))

    await service.fetchInactiveCodexAccounts()

    expect(fetchCodexRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({
        codexHomePath: wslCodexHome,
        allowPtyFallback: false,
        signal: expect.any(AbortSignal)
      })
    )
    expect(service.getState().inactiveCodexAccounts).toEqual([
      {
        accountId: 'account-1',
        rateLimits: expect.objectContaining({
          provider: 'codex',
          session: expect.objectContaining({ usedPercent: 33 })
        }),
        updatedAt: expect.any(Number),
        isFetching: false
      }
    ])
  })

  it('skips an unavailable inactive home without dropping its cache and recovers later', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T12:00:00Z'))
    try {
      const service = new RateLimitService()
      let unavailable = false
      service.setInactiveCodexAccountsResolver(() => [
        {
          id: 'account-1',
          resolveHome: () =>
            unavailable
              ? { kind: 'skip' as const }
              : { kind: 'ready' as const, managedHomePath: '/tmp/account-1/home' }
        }
      ])
      vi.mocked(fetchCodexRateLimits)
        .mockResolvedValueOnce(okProvider('codex', 33, Date.now()))
        .mockResolvedValueOnce(okProvider('codex', 67, Date.now()))

      await service.fetchInactiveCodexAccounts()
      unavailable = true
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await service.fetchInactiveCodexAccounts()

      expect(fetchCodexRateLimits).toHaveBeenCalledOnce()
      expect(service.getState().inactiveCodexAccounts).toEqual([
        expect.objectContaining({
          accountId: 'account-1',
          isFetching: false,
          rateLimits: expect.objectContaining({
            session: expect.objectContaining({ usedPercent: 33 })
          })
        })
      ])

      unavailable = false
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await service.fetchInactiveCodexAccounts()

      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().inactiveCodexAccounts[0]?.rateLimits?.session?.usedPercent).toBe(67)
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows usage-panel Fable supplements for inactive Claude account previews', async () => {
    const service = new RateLimitService()
    const account = { id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }
    service.setInactiveClaudeAccountsResolver(() => [account])
    vi.mocked(fetchManagedAccountUsage).mockResolvedValueOnce(okProvider('claude', 33, Date.now()))

    await service.fetchInactiveClaudeAccounts()

    expect(fetchManagedAccountUsage).toHaveBeenCalledWith(
      account,
      expect.objectContaining({
        allowUsagePanelSupplement: true,
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('does not start overlapping inactive Claude preview fetches', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }
    ])
    vi.mocked(fetchManagedAccountUsage).mockReturnValueOnce(accountFetch.promise)

    const firstFetch = service.fetchInactiveClaudeAccounts()
    await Promise.resolve()
    await service.fetchInactiveClaudeAccounts()

    expect(fetchManagedAccountUsage).toHaveBeenCalledTimes(1)

    accountFetch.resolve(okProvider('claude', 50, Date.now()))
    await firstFetch
  })

  it('does not start overlapping inactive Codex preview fetches', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    service.setInactiveCodexAccountsResolver(() => [
      inactiveCodexAccount('account-1', '/tmp/account-1/home')
    ])
    vi.mocked(fetchCodexRateLimits).mockReturnValueOnce(accountFetch.promise)

    const firstFetch = service.fetchInactiveCodexAccounts()
    await Promise.resolve()
    await service.fetchInactiveCodexAccounts()

    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

    accountFetch.resolve(okProvider('codex', 50, Date.now()))
    await firstFetch
  })

  it('keeps sibling inactive Codex preview fetches alive when one account is evicted', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    let inactiveAccounts = [
      inactiveCodexAccount('account-a', '/tmp/account-a/home'),
      inactiveCodexAccount('account-b', '/tmp/account-b/home')
    ]
    service.setInactiveCodexAccountsResolver(() => inactiveAccounts)
    vi.mocked(fetchCodexRateLimits).mockReturnValueOnce(accountFetch.promise)

    const fetchOnOpen = service.fetchInactiveCodexAccounts()
    await Promise.resolve()
    expect(service.getState().inactiveCodexAccounts).toEqual([
      { accountId: 'account-a', rateLimits: null, updatedAt: 0, isFetching: true }
    ])

    inactiveAccounts = [inactiveCodexAccount('account-a', '/tmp/account-a/home')]
    service.evictInactiveCodexCache('account-b')
    accountFetch.resolve(okProvider('codex', 64, Date.now()))
    await fetchOnOpen

    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
    expect(service.getState().inactiveCodexAccounts).toEqual([
      {
        accountId: 'account-a',
        rateLimits: expect.objectContaining({
          provider: 'codex',
          session: expect.objectContaining({ usedPercent: 64 })
        }),
        updatedAt: expect.any(Number),
        isFetching: false
      }
    ])
  })

  it('does not recache an inactive Codex account that becomes active during fetch-on-open', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    let inactiveAccounts = [inactiveCodexAccount('account-b', '/tmp/account-b/home')]
    service.setInactiveCodexAccountsResolver(() => inactiveAccounts)
    service.setCodexHomePathResolver(() => ({
      kind: 'ready',
      codexHomePath: '/tmp/account-b/home'
    }))
    vi.mocked(fetchCodexRateLimits)
      .mockReturnValueOnce(accountFetch.promise)
      .mockResolvedValueOnce(okProvider('codex', 7, Date.now()))

    const fetchOnOpen = service.fetchInactiveCodexAccounts()
    await Promise.resolve()
    expect(service.getState().inactiveCodexAccounts).toEqual([
      { accountId: 'account-b', rateLimits: null, updatedAt: 0, isFetching: true }
    ])

    inactiveAccounts = []
    await service.refreshForCodexAccountChange('account-a')
    accountFetch.resolve(okProvider('codex', 42, Date.now()))
    await fetchOnOpen

    expect(service.getState().inactiveCodexAccounts).toEqual([])
  })

  it('keeps the inactive Codex debounce across an account switch instead of re-probing', async () => {
    const service = new RateLimitService()
    service.setInactiveCodexAccountsResolver(() => [
      inactiveCodexAccount('account-b', '/tmp/account-b/home')
    ])
    vi.mocked(fetchCodexRateLimits).mockImplementation(async () => okProvider('codex', 10))

    await service.fetchInactiveCodexAccounts()
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

    // The switch triggers exactly one fetch: the newly active account's.
    await service.refreshForCodexAccountChange('account-a')
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)

    // Why: re-opening the switcher inside the debounce window must not spawn
    // codex in every inactive credential home again.
    await service.fetchInactiveCodexAccounts()
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })

  it('staggers inactive Codex probes instead of bursting every account at once', async () => {
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      service.setInactiveCodexAccountsResolver(() => [
        inactiveCodexAccount('account-a', '/tmp/account-a/home'),
        inactiveCodexAccount('account-b', '/tmp/account-b/home')
      ])
      vi.mocked(fetchCodexRateLimits).mockImplementation(async () => okProvider('codex', 5))

      const fetchOnOpen = service.fetchInactiveCodexAccounts()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1_999)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
      await fetchOnOpen
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start another inactive Codex batch during the inter-account stagger', async () => {
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      service.setInactiveCodexAccountsResolver(() => [
        inactiveCodexAccount('account-a', '/tmp/account-a/home'),
        inactiveCodexAccount('account-b', '/tmp/account-b/home')
      ])
      vi.mocked(fetchCodexRateLimits).mockImplementation(async () => okProvider('codex', 5))

      const fetchOnOpen = service.fetchInactiveCodexAccounts()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchCodexRateLimits).toHaveBeenCalledOnce()
      expect(service.getState().inactiveCodexAccounts).toEqual([
        expect.objectContaining({ accountId: 'account-a', isFetching: false })
      ])

      await service.fetchInactiveCodexAccounts()
      expect(fetchCodexRateLimits).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(2_000)
      await fetchOnOpen
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not recache an inactive Claude account removed during fetch-on-open', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    let inactiveAccounts = [{ id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }]
    service.setInactiveClaudeAccountsResolver(() => inactiveAccounts)
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: '/tmp/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }))
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    await service.refresh()
    vi.mocked(fetchManagedAccountUsage).mockReturnValueOnce(accountFetch.promise)

    const fetchOnOpen = service.fetchInactiveClaudeAccounts()
    await Promise.resolve()
    expect(service.getState().inactiveClaudeAccounts).toEqual([
      { accountId: 'account-1', rateLimits: null, updatedAt: 0, isFetching: true }
    ])

    service.evictInactiveClaudeCache('account-1')
    inactiveAccounts = [{ id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }]
    await service.refreshForClaudeAccountChange('account-1')
    expect(service.getState().inactiveClaudeAccounts[0]?.accountId).toBe('account-1')

    inactiveAccounts = []
    service.evictInactiveClaudeCache('account-1')
    accountFetch.resolve(okProvider('claude', 42))
    await fetchOnOpen

    expect(service.getState().inactiveClaudeAccounts).toEqual([])
  })

  it('does not overwrite inactive Claude cache from a stale same-id fetch', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }
    ])
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: '/tmp/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }))
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    await service.refresh()
    vi.mocked(fetchManagedAccountUsage).mockReturnValueOnce(accountFetch.promise)

    const fetchOnOpen = service.fetchInactiveClaudeAccounts()
    await Promise.resolve()

    await service.refreshForClaudeAccountChange('account-1')
    accountFetch.resolve(okProvider('claude', 42))
    await fetchOnOpen

    expect(service.getState().inactiveClaudeAccounts).toEqual([
      {
        accountId: 'account-1',
        rateLimits: expect.objectContaining({
          provider: 'claude',
          session: expect.objectContaining({ usedPercent: 7 })
        }),
        updatedAt: expect.any(Number),
        isFetching: false
      }
    ])
  })

  function managedAccountContext() {
    return {
      activeClaudeAccountId: null,
      activeCodexAccountId: null,
      claudeSystemDefault: null,
      codexSystemDefault: null
    }
  }

  // Why: per-account status-bar meters are only correct if the poll refreshes them; before this,
  // inactive usage was fetched solely when the account switcher was expanded.
  it('refreshes inactive accounts from the poll cycle', async () => {
    const service = new RateLimitService()
    service.setManagedAccountContextResolver(managedAccountContext)
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }
    ])
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: '/tmp/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }))
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchManagedAccountUsage).mockResolvedValue(okProvider('claude', 61))

    await service.refresh()
    await vi.waitFor(() =>
      expect(service.getState().inactiveClaudeAccounts).toEqual([
        {
          accountId: 'account-1',
          rateLimits: expect.objectContaining({
            session: expect.objectContaining({ usedPercent: 61 })
          }),
          updatedAt: expect.any(Number),
          isFetching: false
        }
      ])
    )
  })

  // Why: with no consumer of per-account lanes, the extra per-account calls are pure waste.
  it('skips the poll-driven inactive refresh when no account context is published', async () => {
    const service = new RateLimitService()
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }
    ])
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchManagedAccountUsage).mockResolvedValue(okProvider('claude', 61))

    await service.refresh()

    expect(fetchManagedAccountUsage).not.toHaveBeenCalled()
  })

  // Why: a swallowed per-account failure kept the previous percentage cached forever. Rendered as
  // a permanent pill, that reports a number nothing observed.
  it('records a per-account failure instead of keeping the previous percentage', async () => {
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      service.setInactiveClaudeAccountsResolver(() => [
        { id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }
      ])
      vi.mocked(fetchManagedAccountUsage).mockResolvedValueOnce(okProvider('claude', 61))
      await service.fetchInactiveClaudeAccounts()
      expect(service.getState().inactiveClaudeAccounts[0]?.rateLimits?.session?.usedPercent).toBe(
        61
      )

      // Past the per-batch debounce so the next call actually refetches.
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      vi.mocked(fetchManagedAccountUsage).mockRejectedValueOnce(new Error('429 Too Many Requests'))
      await service.fetchInactiveClaudeAccounts()

      const entry = service.getState().inactiveClaudeAccounts[0]
      expect(entry?.rateLimits).toMatchObject({
        status: 'error',
        error: '429 Too Many Requests'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: a Codex home path is runtime-specific. The host `~/.codex` is not a WSL distro's, so a
  // resolver that cannot see the target would offer a host lane under a WSL reading.
  it('passes the codex fetch target to the inactive-accounts resolver', async () => {
    const service = new RateLimitService()
    const seenTargets: { runtime: string; wslDistro: string | null }[] = []
    service.setInactiveCodexAccountsResolver((target) => {
      seenTargets.push(target)
      return []
    })

    await service.fetchInactiveCodexAccounts()
    expect(seenTargets).toContainEqual({ runtime: 'host', wslDistro: null })

    seenTargets.length = 0
    service.setCodexFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    await service.fetchInactiveCodexAccounts()
    expect(seenTargets).toContainEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  // Why: adding an account previously left its status-bar meter reading "--" until the next
  // poll — up to the full interval — which reads as broken rather than pending.
  it('refetches inactive lanes when the account roster changes', async () => {
    const service = new RateLimitService()
    service.setManagedAccountContextResolver(managedAccountContext)
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'account-new', managedAuthPath: '/tmp/account-new/auth' }
    ])
    vi.mocked(fetchManagedAccountUsage).mockResolvedValue(okProvider('claude', 23))

    service.evictInactiveClaudeCache('account-new')

    await vi.waitFor(() =>
      expect(service.getState().inactiveClaudeAccounts[0]?.rateLimits?.session?.usedPercent).toBe(
        23
      )
    )
  })

  it('does not refetch on a roster change when no account context is published', async () => {
    const service = new RateLimitService()
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'account-new', managedAuthPath: '/tmp/account-new/auth' }
    ])
    vi.mocked(fetchManagedAccountUsage).mockResolvedValue(okProvider('claude', 23))

    service.evictInactiveClaudeCache('account-new')
    await Promise.resolve()

    expect(fetchManagedAccountUsage).not.toHaveBeenCalled()
  })
})
