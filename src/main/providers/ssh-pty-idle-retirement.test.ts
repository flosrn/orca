import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { PTY_IDLE_RETIREMENT_VERSION } from '../../shared/pty-idle-retirement'
import { requestSshPtyIdleRetirement } from './ssh-pty-idle-retirement'

const CAPABLE = { idleRetirementVersion: PTY_IDLE_RETIREMENT_VERSION }

type RelayRequest = Mock<(method: string, params?: unknown, options?: unknown) => Promise<unknown>>
type RetirementArgs = Parameters<typeof requestSshPtyIdleRetirement>[0]

/** A relay mux answering each method from `answers`; a function answer may throw. */
function relay(answers: Record<string, () => unknown>): {
  mux: RetirementArgs['mux']
  request: RelayRequest
} {
  const request: RelayRequest = vi.fn(async (method: string) => {
    const answer = answers[method]
    if (!answer) {
      throw new Error(`unexpected relay method ${method}`)
    }
    return answer()
  })
  return { mux: { request } as RetirementArgs['mux'], request }
}

function retire(mux: RetirementArgs['mux'], overrides: Partial<RetirementArgs> = {}) {
  return requestSshPtyIdleRetirement({
    mux,
    relayPtyId: 'relay-pty-1',
    ownerClientInstanceId: 'client-1',
    request: { expectedIncarnationId: 'incarnation-1' },
    ...overrides
  })
}

const retireIdleCalls = (request: RelayRequest) =>
  request.mock.calls.filter(([method]) => method === 'pty.retireIdle')

describe('requestSshPtyIdleRetirement', () => {
  it('retains the pane as unverifiable and never asks for a stop when capabilities fail', async () => {
    const { mux, request } = relay({
      'pty.getCapabilities': () => {
        throw new Error('channel closed')
      },
      'pty.retireIdle': () => ({ outcome: 'stopped' })
    })

    expect(await retire(mux)).toEqual({ outcome: 'retained', reason: 'unverifiable' })
    expect(retireIdleCalls(request)).toEqual([])
  })

  it.each([
    ['an older relay with no version', {}],
    [
      'a relay advertising another version',
      { idleRetirementVersion: PTY_IDLE_RETIREMENT_VERSION + 1 }
    ],
    ['a non-object reply', null]
  ])(
    'never sends a stop to %s, which would tear the pane down unconditionally',
    async (_label, capabilities) => {
      const { mux, request } = relay({
        'pty.getCapabilities': () => capabilities,
        'pty.retireIdle': () => ({ outcome: 'stopped' })
      })

      expect(await retire(mux)).toEqual({ outcome: 'retained', reason: 'unsupported' })
      expect(retireIdleCalls(request)).toEqual([])
    }
  )

  it('reads a lost reply after the stop was sent as unconfirmed, never retained or absent', async () => {
    const { mux } = relay({
      'pty.getCapabilities': () => CAPABLE,
      'pty.retireIdle': () => {
        throw new Error('remote disconnected')
      }
    })

    expect(await retire(mux)).toEqual({ outcome: 'unconfirmed' })
  })

  it.each([
    ['an unknown outcome', { outcome: 'gone' }],
    ['a retain without a known reason', { outcome: 'retained', reason: 'because' }],
    ['no reply body', undefined]
  ])('reads %s as unconfirmed', async (_label, reply) => {
    const { mux } = relay({
      'pty.getCapabilities': () => CAPABLE,
      'pty.retireIdle': () => reply
    })

    expect(await retire(mux)).toEqual({ outcome: 'unconfirmed' })
  })

  it('passes the host verdict through', async () => {
    const { mux } = relay({
      'pty.getCapabilities': () => CAPABLE,
      'pty.retireIdle': () => ({ outcome: 'retained', reason: 'output_advanced' })
    })

    expect(await retire(mux)).toEqual({ outcome: 'retained', reason: 'output_advanced' })
  })

  it('forwards the owner claim and output fence the relay enforces', async () => {
    const { mux, request } = relay({
      'pty.getCapabilities': () => CAPABLE,
      'pty.retireIdle': () => ({ outcome: 'stopped' })
    })

    await retire(mux, {
      request: { expectedIncarnationId: 'incarnation-1', expectedOutputChars: 42 }
    })

    expect(retireIdleCalls(request)[0]?.[1]).toEqual({
      id: 'relay-pty-1',
      expectedIncarnationId: 'incarnation-1',
      expectedOwnerClientInstanceId: 'client-1',
      expectedOutputChars: 42
    })
  })

  it('omits claims the caller does not hold rather than sending empty ones', async () => {
    const { mux, request } = relay({
      'pty.getCapabilities': () => CAPABLE,
      'pty.retireIdle': () => ({ outcome: 'stopped' })
    })

    await retire(mux, { ownerClientInstanceId: null })

    expect(retireIdleCalls(request)[0]?.[1]).toEqual({
      id: 'relay-pty-1',
      expectedIncarnationId: 'incarnation-1'
    })
  })

  describe('with a deadline', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(10_000)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('bounds both relay requests by the time left before the deadline', async () => {
      const { mux, request } = relay({
        'pty.getCapabilities': () => CAPABLE,
        'pty.retireIdle': () => ({ outcome: 'stopped' })
      })

      await retire(mux, {
        request: { expectedIncarnationId: 'incarnation-1', deadlineMs: 12_500 }
      })

      expect(request.mock.calls.map(([method, , options]) => [method, options])).toEqual([
        ['pty.getCapabilities', { timeoutMs: 2_500 }],
        ['pty.retireIdle', { timeoutMs: 2_500 }]
      ])
    })
  })
})
