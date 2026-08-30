import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyRefreshedToken,
  isOauthTokenExpired,
  isOauthTokenExpiring,
  parseClaudeOauthBlob,
  readRefreshToken,
  refreshClaudeOauthCredentials,
  refreshClaudeOauthCredentialsOutcome,
  resetClaudeOauthRefreshRuntimeStateForTest
} from './oauth-refresh'

const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock },
  session: { defaultSession: {} }
}))

vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn().mockResolvedValue({ source: 'none' })
}))

const NOW = 1_700_000_000_000

function credentials(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['user:inference', 'user:profile'],
      ...overrides
    }
  })
}

describe('parseClaudeOauthBlob', () => {
  it('returns the oauth block', () => {
    expect(parseClaudeOauthBlob(credentials())?.accessToken).toBe('old-access')
  })

  it('returns null for non-JSON or missing block', () => {
    expect(parseClaudeOauthBlob('not json')).toBeNull()
    expect(parseClaudeOauthBlob('{}')).toBeNull()
    expect(parseClaudeOauthBlob('{"claudeAiOauth":[]}')).toBeNull()
  })
})

describe('readRefreshToken', () => {
  it('reads a present token', () => {
    expect(readRefreshToken(credentials())).toBe('old-refresh')
  })

  it('returns null for blank or missing tokens', () => {
    expect(readRefreshToken(credentials({ refreshToken: '   ' }))).toBeNull()
    expect(readRefreshToken(credentials({ refreshToken: undefined }))).toBeNull()
  })
})

describe('isOauthTokenExpiring', () => {
  it('is false when well within validity', () => {
    expect(isOauthTokenExpiring(credentials(), NOW)).toBe(false)
  })

  it('is true within the 5-minute buffer', () => {
    expect(isOauthTokenExpiring(credentials({ expiresAt: NOW + 60 * 1000 }), NOW)).toBe(true)
  })

  it('is true when already expired', () => {
    expect(isOauthTokenExpiring(credentials({ expiresAt: NOW - 1000 }), NOW)).toBe(true)
  })

  it('treats missing/non-numeric expiry as expiring', () => {
    expect(isOauthTokenExpiring(credentials({ expiresAt: undefined }), NOW)).toBe(true)
    expect(isOauthTokenExpiring(credentials({ expiresAt: 'soon' }), NOW)).toBe(true)
  })

  it('is false for credentials without an oauth block', () => {
    expect(isOauthTokenExpiring('{}', NOW)).toBe(false)
  })
})

describe('applyRefreshedToken', () => {
  it('rotates access + refresh token and recomputes expiry', () => {
    const updated = applyRefreshedToken(
      credentials(),
      { access_token: 'new-access', expires_in: 3600, refresh_token: 'new-refresh' },
      NOW
    )
    const oauth = parseClaudeOauthBlob(updated!)!
    expect(oauth.accessToken).toBe('new-access')
    expect(oauth.refreshToken).toBe('new-refresh')
    expect(oauth.expiresAt).toBe(NOW + 3600 * 1000)
  })

  it('keeps the existing refresh token when the server does not rotate it', () => {
    const updated = applyRefreshedToken(
      credentials(),
      { access_token: 'new-access', expires_in: 3600 },
      NOW
    )
    expect(parseClaudeOauthBlob(updated!)!.refreshToken).toBe('old-refresh')
  })

  it('preserves unrelated top-level fields', () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r' },
      somethingElse: { keep: true }
    })
    const updated = applyRefreshedToken(raw, { access_token: 'b' }, NOW)
    expect(JSON.parse(updated!).somethingElse).toEqual({ keep: true })
  })

  it('splits scope string into scopes array', () => {
    const updated = applyRefreshedToken(
      credentials(),
      { access_token: 'b', scope: 'user:inference user:profile' },
      NOW
    )
    expect(parseClaudeOauthBlob(updated!)!.scopes).toEqual(['user:inference', 'user:profile'])
  })

  it('returns null when the response lacks an access token', () => {
    expect(applyRefreshedToken(credentials(), {}, NOW)).toBeNull()
    expect(applyRefreshedToken('not json', { access_token: 'b' }, NOW)).toBeNull()
  })
})

describe('refreshClaudeOauthCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetClaudeOauthRefreshRuntimeStateForTest()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns null without a refresh token (no network call)', async () => {
    const result = await refreshClaudeOauthCredentials(
      credentials({ refreshToken: undefined }),
      NOW
    )
    expect(result).toBeNull()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('posts a form-urlencoded refresh grant and persists the rotation', async () => {
    netFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'fresh-access',
        expires_in: 3600,
        refresh_token: 'fresh-refresh'
      })
    })

    const result = await refreshClaudeOauthCredentials(credentials(), NOW)

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = netFetchMock.mock.calls[0]
    expect(url).toBe('https://platform.claude.com/v1/oauth/token')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(init.body)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old-refresh')
    expect(body.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')

    const oauth = parseClaudeOauthBlob(result!)!
    expect(oauth.accessToken).toBe('fresh-access')
    expect(oauth.refreshToken).toBe('fresh-refresh')
  })

  it('returns null on a non-ok response and logs the status for diagnosability', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    netFetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    expect(await refreshClaudeOauthCredentials(credentials(), NOW)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('429'))
    warn.mockRestore()
  })

  it('returns null when the request throws (never rejects)', async () => {
    netFetchMock.mockRejectedValue(new Error('network down'))
    await expect(refreshClaudeOauthCredentials(credentials(), NOW)).resolves.toBeNull()
  })
})

describe('isOauthTokenExpired', () => {
  it('is false within validity and inside the refresh buffer', () => {
    expect(isOauthTokenExpired(credentials(), NOW)).toBe(false)
    expect(isOauthTokenExpired(credentials({ expiresAt: NOW + 60_000 }), NOW)).toBe(false)
  })

  it('is true only at and past a provable expiry', () => {
    expect(isOauthTokenExpired(credentials({ expiresAt: NOW }), NOW)).toBe(true)
    expect(isOauthTokenExpired(credentials({ expiresAt: NOW - 1 }), NOW)).toBe(true)
    // Why: missing expiry metadata is not proof — the server judges the bearer.
    expect(isOauthTokenExpired(credentials({ expiresAt: undefined }), NOW)).toBe(false)
  })
})

describe('refreshClaudeOauthCredentialsOutcome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetClaudeOauthRefreshRuntimeStateForTest()
  })

  it('shares one exchange across concurrent callers of the same token', async () => {
    const { promise, resolve: resolveFetch } = Promise.withResolvers<unknown>()
    netFetchMock.mockReturnValue(promise)
    const a = refreshClaudeOauthCredentialsOutcome(credentials(), NOW)
    const b = refreshClaudeOauthCredentialsOutcome(credentials(), NOW)
    resolveFetch({
      ok: true,
      json: async () => ({
        access_token: 'fresh-access',
        expires_in: 3600,
        refresh_token: 'fresh-refresh'
      })
    })
    const [first, second] = await Promise.all([a, b])
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(parseClaudeOauthBlob(first.credentialsJson!)!.refreshToken).toBe('fresh-refresh')
    expect(parseClaudeOauthBlob(second.credentialsJson!)!.refreshToken).toBe('fresh-refresh')
  })

  it('serves a just-rotated token from the memo instead of re-POSTing it', async () => {
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'fresh-access',
        expires_in: 3600,
        refresh_token: 'fresh-refresh'
      })
    })
    await refreshClaudeOauthCredentialsOutcome(credentials(), NOW)
    const replay = await refreshClaudeOauthCredentialsOutcome(credentials(), NOW)
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(parseClaudeOauthBlob(replay.credentialsJson!)!.accessToken).toBe('fresh-access')
  })

  it('reports status and Retry-After on a 429 and cools down instead of re-POSTing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    netFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '120' }),
      json: async () => ({})
    })
    const first = await refreshClaudeOauthCredentialsOutcome(credentials(), NOW)
    expect(first.credentialsJson).toBeNull()
    expect(first.failure).toMatchObject({ status: 429, retryAfterMs: 120_000 })
    const second = await refreshClaudeOauthCredentialsOutcome(credentials(), NOW)
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(second.failure).toMatchObject({ status: 429 })
    warn.mockRestore()
  })

  it('memoizes a rejected token without blocking a re-authenticated one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    netFetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      json: async () => ({})
    })
    const rejected = await refreshClaudeOauthCredentialsOutcome(credentials(), NOW)
    expect(rejected.failure).toMatchObject({ status: 400, retryAfterMs: null })
    // Why: a re-auth stores a NEW refresh token, which must not hit the memo.
    const rebound = await refreshClaudeOauthCredentialsOutcome(
      credentials({ refreshToken: 'reissued-refresh' }),
      NOW
    )
    expect(netFetchMock).toHaveBeenCalledTimes(2)
    expect(rebound.failure).toMatchObject({ status: 400 })
    warn.mockRestore()
  })
})
