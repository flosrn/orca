import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { MAX_RUNTIME_RPC_CONNECTIONS } from './rpc/unix-socket-transport'
import { LONG_POLL_CAP } from './runtime-rpc/runtime-rpc-long-poll'
import { getLongPollCapacityReport } from './runtime-rpc/runtime-rpc-long-poll-capacity'
import { openFramedSession, sendRequest, sleep } from './runtime-rpc-test-harness'

describe('runtime long-poll capacity evidence', () => {
  it('keeps the cap at half the socket budget, sized for a worker wave', () => {
    expect(LONG_POLL_CAP).toBe(MAX_RUNTIME_RPC_CONNECTIONS / 2)
    // Why: every dispatched worker parks one `check --wait` for its whole life,
    // and the coordinator, the operator's own clients and each in-flight
    // worker-start take one more. Measured 2026-09-02: a ten-worker wave held
    // the old 16-slot cap saturated for 67 minutes, refusing everything that
    // arrived. Anything below 20 puts a wave of that size back at the fence.
    expect(LONG_POLL_CAP).toBeGreaterThanOrEqual(20)
  })

  it('records a refused long-poll in the message and in status.get', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      keepaliveIntervalMs: 1000,
      longPollCap: 1
    })
    await server.start()

    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const endpoint = metadata!.transports[0]!.endpoint

      const parked = openFramedSession(endpoint, {
        id: 'req_parked',
        authToken: metadata!.authToken,
        method: 'orchestration.check',
        params: { terminal: 'term_a', wait: true, timeoutMs: 5_000 }
      })
      await sleep(100)

      const refused = await sendRequest(endpoint, {
        id: 'req_refused',
        authToken: metadata!.authToken,
        method: 'orchestration.check',
        params: { terminal: 'term_b', wait: true, timeoutMs: 5_000 }
      })
      // Why: the refused client is the only witness — the fence answers before
      // any handler runs, so no receipt, dispatch row or stage records it.
      expect(refused).toMatchObject({
        id: 'req_refused',
        ok: false,
        error: {
          code: 'runtime_busy',
          message:
            'long-poll capacity reached (held 1/1: 1 wait, 0 ask, 0 browser-host); retry with backoff'
        }
      })

      const status = await sendRequest(endpoint, {
        id: 'req_status',
        authToken: metadata!.authToken,
        method: 'status.get'
      })
      // Why: asserted on the whole result — the report is the durable half of
      // the evidence, readable long after the refused client is gone.
      expect(status.result).toMatchObject({
        longPollCapacity: {
          cap: 1,
          held: 1,
          heldByClass: { ask: 0, 'browser-host': 0, wait: 1 },
          peakHeld: 1,
          peakHeldAt: expect.any(String),
          refusedByClass: { ask: 0, 'browser-host': 0, wait: 1 },
          lastRefusalAt: expect.any(String)
        }
      })

      parked.socket.destroy()
      await parked.done
    } finally {
      db.close()
      await server.stop()
    }

    // Why: a stopped runtime holds nothing, so status must stop answering for it.
    expect(getLongPollCapacityReport(runtime.getRuntimeId())).toBeNull()
  })
})
