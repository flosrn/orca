// Why: the usage endpoint enforces roughly 28-30 reads per identity-hour on a
// sliding window (measured by claude-swap's poll_policy and claude-code#77477).
// Spending the full budget earns per-token 429s with retry-after up to an hour,
// so a client-side cap keeps polls under the server's threshold.
const WINDOW_MS = 60 * 60 * 1000
const MAX_CALLS_PER_WINDOW = 25

const callTimesByToken = new Map<string, number[]>()

export type ClaudeUsageBudgetDecision = { ok: true } | { ok: false; retryAfterMs: number }

export function takeClaudeUsagePollBudget(
  token: string,
  now: number = Date.now()
): ClaudeUsageBudgetDecision {
  const cutoff = now - WINDOW_MS
  for (const [key, times] of callTimesByToken) {
    if (key !== token && (times.at(-1) ?? 0) <= cutoff) {
      callTimesByToken.delete(key)
    }
  }
  const times = (callTimesByToken.get(token) ?? []).filter((t) => t > cutoff)
  if (times.length >= MAX_CALLS_PER_WINDOW) {
    callTimesByToken.set(token, times)
    return { ok: false, retryAfterMs: times[0] + WINDOW_MS - now }
  }
  times.push(now)
  callTimesByToken.set(token, times)
  return { ok: true }
}

export function resetClaudeUsagePollBudgetForTest(): void {
  callTimesByToken.clear()
}
