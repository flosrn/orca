import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetClaudeUsagePollBudgetForTest,
  takeClaudeUsagePollBudget
} from './claude-usage-poll-budget'

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

describe('takeClaudeUsagePollBudget', () => {
  beforeEach(() => {
    resetClaudeUsagePollBudgetForTest()
  })

  it('allows 25 calls per identity-hour then defers with a retry hint', () => {
    for (let i = 0; i < 25; i++) {
      expect(takeClaudeUsagePollBudget('token-a', NOW + i * 1000)).toEqual({ ok: true })
    }
    const deferred = takeClaudeUsagePollBudget('token-a', NOW + 26_000)
    expect(deferred.ok).toBe(false)
    if (!deferred.ok) {
      expect(deferred.retryAfterMs).toBe(NOW + HOUR - (NOW + 26_000))
    }
  })

  it('frees budget as the sliding window moves past old calls', () => {
    for (let i = 0; i < 25; i++) {
      takeClaudeUsagePollBudget('token-a', NOW + i * 1000)
    }
    expect(takeClaudeUsagePollBudget('token-a', NOW + HOUR + 500).ok).toBe(true)
  })

  it('budgets keys independently', () => {
    for (let i = 0; i < 25; i++) {
      takeClaudeUsagePollBudget('managed:account-1', NOW + i * 1000)
    }
    expect(takeClaudeUsagePollBudget('managed:account-1', NOW + 26_000).ok).toBe(false)
    expect(takeClaudeUsagePollBudget('managed:account-2', NOW + 26_000).ok).toBe(true)
  })
})
