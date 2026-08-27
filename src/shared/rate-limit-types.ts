export type RateLimitWindow = {
  /** Percentage of the window consumed (0–100). */
  usedPercent: number
  /** Window duration in minutes: 300 (5h) or 10080 (7d). */
  windowMinutes: number
  /** Unix ms timestamp when the window resets, if known. */
  resetsAt: number | null
  /** Human-readable reset description, e.g. "2:30 PM" or "Thu". */
  resetDescription: string | null
}

export type ProviderRateLimitStatus = 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable'

export type RateLimitBucket = RateLimitWindow & {
  name: string
}

export type UsageRateLimitSource = 'oauth' | 'cli' | 'web' | 'live-session'

export type UsageRateLimitFailureKind =
  | 'missing-credentials'
  | 'stale-token'
  | 'refreshable-credentials-without-token'
  | 'delegated-refresh-required'
  | 'deferred-by-live-session'
  | 'keychain-unavailable'
  | 'missing-scope'
  | 'network'
  | 'server'
  | 'parse'
  | 'rate-limited'
  | 'cli-unavailable'
  | 'usage-unavailable'
  | 'unknown'

export type UsageRateLimitMetadata = {
  source?: UsageRateLimitSource
  attemptedSources?: UsageRateLimitSource[]
  failureKind?: UsageRateLimitFailureKind
  credentialSource?: string
  authProvenance?: string
  deferredByLiveClaudeSession?: boolean
  lastSuccessfulSource?: UsageRateLimitSource
  /** Unix ms timestamp before which usage refetches should not be attempted (from HTTP Retry-After). */
  retryAtMs?: number
}

export type ProviderRateLimits = {
  provider:
    | 'claude'
    | 'codex'
    | 'gemini'
    | 'opencode-go'
    | 'kimi'
    | 'minimax'
    | 'grok'
    | 'antigravity'
    // Metered through the CodexBar CLI rather than a native fetcher; see
    // src/main/rate-limits/codexbar-cli-source.ts.
    | 'cursor'
    | 'clinepass'
    | 'qwencloud'
  /** 5-hour session window, null if not available. */
  session: RateLimitWindow | null
  /** 7-day weekly window, null if not available. */
  weekly: RateLimitWindow | null
  /** Claude Fable 7-day weekly window, null if not available. */
  fableWeekly?: RateLimitWindow | null
  /** 30-day monthly window (OpenCode Go, Grok unified billing), null if not available. */
  monthly?: RateLimitWindow | null
  /** Named per-model buckets (Gemini only). */
  buckets?: RateLimitBucket[]
  /** Available earned Codex rate-limit reset credits, if reported. */
  rateLimitResetCredits?: {
    availableCount: number
    /** Total earned reset credits, including spent or expired credits, if reported. */
    totalEarnedCount?: number
    /** Unix ms timestamp for the next available reset credit expiry, if reported. */
    nextExpiresAt?: number | null
    credits?: {
      status: string
      expiresAt: number | null
      grantedAt: number | null
    }[]
  } | null
  /** Subscription plan tier for the active account (Codex `plan_type`, e.g. "plus"). */
  planType?: string | null
  /** Unix ms timestamp of the last successful data update. */
  updatedAt: number
  /** Human-readable error message, null when status is 'ok'. */
  error: string | null
  status: ProviderRateLimitStatus
  usageMetadata?: UsageRateLimitMetadata
}

export type CodexRateLimitResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'

export type CodexRateLimitResetResult = {
  outcome: CodexRateLimitResetOutcome
  state: RateLimitState
}

export type RateLimitRuntimeTarget = {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
}

export type InactiveAccountUsage = {
  accountId: string
  rateLimits: ProviderRateLimits | null
  updatedAt: number
  isFetching: boolean
}

export type GrokAccountStatus = {
  signedIn: boolean
  email: string | null
  teamId: string | null
  tokenFresh: boolean
  error: string | null
}

/**
 * The provider's own login (real ~/.claude / ~/.codex), when one exists and can carry
 * subscription usage. Null means there is no such lane to show: signed out, or an
 * API-key login with no subscription window. An email is not a presence signal —
 * Claude's own default reports none — so presence is the descriptor's existence.
 */
export type SystemDefaultLaneDescriptor = {
  /** Identity, when resolved. */
  email: string | null
  /** True when usage for this login is fetchable while another account is active. */
  measurableWhenInactive: boolean
}

export type RateLimitState = {
  claude: ProviderRateLimits | null
  codex: ProviderRateLimits | null
  gemini: ProviderRateLimits | null
  opencodeGo: ProviderRateLimits | null
  kimi: ProviderRateLimits | null
  antigravity: ProviderRateLimits | null
  minimax: ProviderRateLimits | null
  grok: ProviderRateLimits | null
  cursor: ProviderRateLimits | null
  clinepass: ProviderRateLimits | null
  qwencloud: ProviderRateLimits | null
  /**
   * True when a MiniMax session cookie is persisted on disk. The cookie lives
   * outside GlobalSettings, so this flag is the durable signal that the
   * status bar uses to keep the MiniMax provider visible across reloads and
   * between snapshot refreshes.
   */
  minimaxCookieConfigured: boolean
  /** True when main finds a Grok CLI session file (~/.grok/auth.json or GROK_HOME). */
  grokAuthConfigured: boolean
  /**
   * True when the CodexBar CLI is on PATH. One flag for all three CodexBar-backed providers:
   * they share a binary, so its absence is the single reason none of them can report. Acts as
   * the durable visibility signal the way `grokAuthConfigured` does, keeping the meters on the
   * bar between snapshot refreshes instead of flickering out.
   */
  codexbarAvailable: boolean
  claudeTarget: RateLimitRuntimeTarget
  codexTarget: RateLimitRuntimeTarget
  /**
   * Managed account the service fetches for, per the current target; `null` selects the
   * system default. Absent (`undefined`) from hosts that predate per-account lanes, and the
   * two cases must stay distinct: `undefined` means "this host cannot say", which degrades
   * to the single active-account meter, while `null` is a positive answer.
   */
  activeClaudeAccountId?: string | null
  activeCodexAccountId?: string | null
  /** `null` when the provider's own login carries no usage lane; absent on older hosts. */
  claudeSystemDefault?: SystemDefaultLaneDescriptor | null
  codexSystemDefault?: SystemDefaultLaneDescriptor | null
  inactiveClaudeAccounts: InactiveAccountUsage[]
  inactiveCodexAccounts: InactiveAccountUsage[]
}
