import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow,
  UsageRateLimitSource
} from '../../shared/rate-limit-types'

/**
 * Providers Orca meters through the CodexBar CLI.
 *
 * Why these three and not CodexBar's full ~80: Claude, Codex and Grok already have native
 * fetchers whose numbers are per-account, and a second CodexBar row for them would double-count
 * one subscription. These three have no native fetcher at all.
 */
export const CODEXBAR_PROVIDERS = ['cursor', 'clinepass', 'qwencloud'] as const

export type CodexBarProvider = (typeof CODEXBAR_PROVIDERS)[number]

/**
 * CLI `--provider` argument per provider id.
 *
 * Why a map and not the id itself: CodexBar accepts `qwen-cloud` on the command line but reports
 * `qwencloud` in the payload's `provider` field, so one of the two spellings has to be chosen as
 * Orca's id and translated at the boundary.
 */
export const CODEXBAR_PROVIDER_CLI_ARGUMENT: Record<CodexBarProvider, string> = {
  cursor: 'cursor',
  clinepass: 'clinepass',
  qwencloud: 'qwen-cloud'
}

const WEEKLY_WINDOW_MINUTES = 10_080

/**
 * One entry of `codexbar usage --format json`, which always returns an array.
 *
 * Every field is optional on purpose: this is an external binary on the user's machine that
 * updates independently of Orca, so the decoder validates rather than trusts. `primary`,
 * `secondary` and `tertiary` are CodexBar's window slots — their durations vary per provider
 * (C‍linePass 5h/7d/30d, C‍ursor 31d/31d/31d, Qwen Cloud 7d only), so the window a slot means is
 * read from `windowMinutes`, never from the slot's name.
 */
type CodexBarWindowPayload = {
  usedPercent?: unknown
  windowMinutes?: unknown
  resetsAt?: unknown
  resetDescription?: unknown
}

type CodexBarEntryPayload = {
  provider?: unknown
  source?: unknown
  error?: { message?: unknown; kind?: unknown } | null
  usage?: {
    primary?: CodexBarWindowPayload | null
    secondary?: CodexBarWindowPayload | null
    tertiary?: CodexBarWindowPayload | null
    extraRateWindows?: unknown
    loginMethod?: unknown
    accountEmail?: unknown
    updatedAt?: unknown
  } | null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * `resetsAt` arrives as an ISO-8601 string; `RateLimitWindow` carries unix ms.
 * An unparseable stamp degrades to `null` (window size shown instead of a countdown)
 * rather than `NaN`, which would render as a garbage duration.
 */
function parseResetsAt(value: unknown): number | null {
  const raw = nonEmptyString(value)
  if (raw === null) {
    return null
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function mapWindow(payload: CodexBarWindowPayload | null | undefined): RateLimitWindow | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const usedPercent = finiteNumber(payload.usedPercent)
  const windowMinutes = finiteNumber(payload.windowMinutes)
  // Why both required: a window with no percentage is not 0% used, and a window with no duration
  // cannot be classified as weekly vs monthly. Either missing means "unknown", so drop the slot.
  if (usedPercent === null || windowMinutes === null || windowMinutes <= 0) {
    return null
  }
  return {
    usedPercent,
    windowMinutes,
    resetsAt: parseResetsAt(payload.resetsAt),
    resetDescription: nonEmptyString(payload.resetDescription)
  }
}

/** CodexBar reports `web`, `api`, `cli`, `oauth`, or `auto`; Orca's vocabulary is narrower. */
function mapSource(value: unknown): UsageRateLimitSource | undefined {
  switch (nonEmptyString(value)) {
    case 'web':
      return 'web'
    case 'cli':
      return 'cli'
    case 'oauth':
      return 'oauth'
    // 'api' and 'auto' have no Orca equivalent; omitting is honest, guessing is not.
    default:
      return undefined
  }
}

/**
 * C‍ursor's named side-pools (`Grok Bot` and friends). They are extra quotas on one subscription,
 * not extra accounts, so they ride along as named buckets the way Gemini's per-model pools do.
 */
function mapExtraBuckets(value: unknown): RateLimitBucket[] {
  if (!Array.isArray(value)) {
    return []
  }
  const buckets: RateLimitBucket[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const candidate = entry as { id?: unknown; title?: unknown; window?: CodexBarWindowPayload }
    const window = mapWindow(candidate.window)
    const name = nonEmptyString(candidate.title) ?? nonEmptyString(candidate.id)
    if (window === null || name === null) {
      continue
    }
    buckets.push({ ...window, name })
  }
  return buckets
}

/**
 * Sort CodexBar's three unnamed slots into Orca's named windows by measured duration.
 *
 * Why duration and not slot name: `primary` is a 5h session for C‍linePass but a 31-day pool for
 * C‍ursor. Anything at or under a week that is not exactly a week counts as the session window,
 * a week is weekly, and anything longer is monthly. Two slots that classify the same way keep
 * the higher-used one, since the pill must report the binding constraint.
 */
function assignWindows(
  slots: readonly (RateLimitWindow | null)[]
): Pick<ProviderRateLimits, 'session' | 'weekly' | 'monthly'> {
  let session: RateLimitWindow | null = null
  let weekly: RateLimitWindow | null = null
  let monthly: RateLimitWindow | null = null
  for (const window of slots) {
    if (window === null) {
      continue
    }
    if (window.windowMinutes === WEEKLY_WINDOW_MINUTES) {
      weekly = weekly === null || window.usedPercent > weekly.usedPercent ? window : weekly
    } else if (window.windowMinutes > WEEKLY_WINDOW_MINUTES) {
      monthly = monthly === null || window.usedPercent > monthly.usedPercent ? window : monthly
    } else {
      session = session === null || window.usedPercent > session.usedPercent ? window : session
    }
  }
  return { session, weekly, monthly }
}

export type CodexBarMapResult = {
  limits: ProviderRateLimits
  /** Account identity CodexBar reported, for the roster row. Null when the provider has none. */
  email: string | null
}

/**
 * Decode one `codexbar usage --provider <id> --format json` payload.
 *
 * `raw` is the CLI's stdout. Every failure path produces a `ProviderRateLimits` rather than
 * throwing, because a provider Orca cannot read must render as "unknown" on the bar — never as
 * 0% used, and never as a crash that takes the whole poll cycle down.
 */
export function mapCodexBarUsage(provider: CodexBarProvider, raw: string): CodexBarMapResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return failure(provider, 'CodexBar returned output that is not JSON', 'parse')
  }
  // The CLI always wraps entries in an array; a bare object is a shape Orca does not know.
  if (!Array.isArray(parsed)) {
    return failure(provider, 'CodexBar returned an unexpected JSON shape', 'parse')
  }
  const entry = parsed.find((candidate): candidate is CodexBarEntryPayload => {
    return Boolean(candidate) && typeof candidate === 'object'
  })
  if (!entry) {
    return failure(provider, 'CodexBar reported no usage for this provider', 'usage-unavailable')
  }

  // A provider-level error (not signed in, cookie expired) is authoritative: report the CLI's own
  // message so the user reads CodexBar's remedy rather than an Orca paraphrase of it.
  const errorMessage = nonEmptyString(entry.error?.message)
  if (errorMessage !== null) {
    return failure(provider, errorMessage, 'missing-credentials')
  }

  const usage = entry.usage
  if (!usage || typeof usage !== 'object') {
    return failure(provider, 'CodexBar reported no usage for this provider', 'usage-unavailable')
  }

  const windows = assignWindows([
    mapWindow(usage.primary),
    mapWindow(usage.secondary),
    mapWindow(usage.tertiary)
  ])
  const buckets = mapExtraBuckets(usage.extraRateWindows)
  if (windows.session === null && windows.weekly === null && windows.monthly === null) {
    // Buckets alone still count as a measurement — a provider can report only named pools.
    if (buckets.length === 0) {
      return failure(provider, 'CodexBar reported no usage windows', 'usage-unavailable')
    }
  }

  const source = mapSource(entry.source)
  return {
    limits: {
      provider,
      session: windows.session,
      weekly: windows.weekly,
      ...(windows.monthly ? { monthly: windows.monthly } : {}),
      ...(buckets.length > 0 ? { buckets } : {}),
      planType: nonEmptyString(usage.loginMethod),
      updatedAt: parseResetsAt(usage.updatedAt) ?? Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: {
        ...(source ? { source, lastSuccessfulSource: source } : {}),
        credentialSource: 'codexbar-cli'
      }
    },
    email: nonEmptyString(usage.accountEmail)
  }
}

/**
 * A provider Orca could not read. `status: 'error'` keeps any previously fetched numbers visible
 * under the service's stale policy; `unavailable` would discard them.
 */
export function failure(
  provider: CodexBarProvider,
  error: string,
  failureKind: NonNullable<NonNullable<ProviderRateLimits['usageMetadata']>['failureKind']>
): CodexBarMapResult {
  return {
    limits: {
      provider,
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error,
      status: 'error',
      usageMetadata: { failureKind, credentialSource: 'codexbar-cli' }
    },
    email: null
  }
}
