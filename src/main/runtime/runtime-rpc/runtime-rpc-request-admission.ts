import type { RuntimeMetadata } from '../../../shared/runtime-bootstrap'
import { writeRuntimeMetadata } from '../runtime-metadata'
import type { RpcMessageContext } from '../rpc/transport'
import type { RpcRequest, RpcResponse } from '../rpc/core'
import { errorResponse } from '../rpc/errors'
import { RuntimeRpcBinaryRouting } from './runtime-rpc-binary-routing'
import { classifyRuntimeLongPoll, type RuntimeLongPollClass } from './runtime-rpc-long-poll'
import {
  describeLongPollRefusal,
  type LongPollCapacityReport
} from './runtime-rpc-long-poll-capacity'

const LONG_POLL_REFUSAL_WARN_INTERVAL_MS = 60_000

export class RuntimeRpcRequestAdmission extends RuntimeRpcBinaryRouting {
  // Why: Unix socket dispatch is one-shot and auths via the shared token from the 0o600 metadata file. See §3.1.
  protected async handleMessage(
    rawMessage: string,
    context?: RpcMessageContext
  ): Promise<RpcResponse> {
    // Why: the transport sends an empty message when a client exceeds max size, then closes the connection.
    if (!rawMessage) {
      return this.buildError('unknown', 'request_too_large', 'RPC request exceeds the maximum size')
    }

    const parsed = this.parseAndAuth(rawMessage)
    if ('error' in parsed) {
      return parsed.error
    }
    const request = parsed.request

    // Why: long-poll admission fence; short RPCs bypass the counter. See §7 risk #2.
    const longPoll = classifyRuntimeLongPoll(request)
    const rejection = this.admitLongPoll(longPoll)
    if (rejection) {
      return this.buildError(request.id, 'runtime_busy', rejection)
    }
    if (longPoll) {
      // Why: arm keepalive only for long-polls; short RPCs never create the setInterval. See §3.1.
      context?.startKeepalive()
    }

    try {
      return await this.dispatcher.dispatch(request, {
        signal: longPoll ? context?.signal : undefined
      })
    } finally {
      this.releaseLongPoll(longPoll)
    }
  }

  // Why: one fence for both transports — the total cap protects short RPCs, the ask
  // sub-cap protects terminal.wait / check --wait from slow reply-blocked asks.
  // Returns the rejection message, or null once the slot is reserved.
  protected admitLongPoll(
    longPoll: RuntimeLongPollClass | null,
    pairedDeviceId?: string
  ): string | null {
    if (!longPoll) {
      return null
    }
    if (this.activeLongPolls >= this.longPollCap) {
      return this.refuseLongPoll(longPoll, 'long-poll capacity reached')
    }
    if (
      (longPoll === 'ask' || longPoll === 'browser-host') &&
      this.activeAskLongPolls + this.activeBrowserHostLongPolls >= this.specializedLongPollCap
    ) {
      return this.refuseLongPoll(
        longPoll,
        longPoll === 'ask' ? 'orchestration.ask capacity reached' : 'browser-host capacity reached'
      )
    }
    if (longPoll === 'ask' && this.activeAskLongPolls >= this.askLongPollCap) {
      return this.refuseLongPoll(longPoll, 'orchestration.ask capacity reached')
    }
    if (
      longPoll === 'browser-host' &&
      (this.activeBrowserHostLongPolls >= this.browserHostLongPollCap ||
        (pairedDeviceId !== undefined &&
          (this.activeBrowserHostLongPollsByDevice.get(pairedDeviceId) ?? 0) >=
            this.browserHostLongPollCapPerDevice))
    ) {
      return this.refuseLongPoll(longPoll, 'browser-host capacity reached')
    }
    this.activeLongPolls += 1
    if (this.activeLongPolls > this.peakLongPolls) {
      this.peakLongPolls = this.activeLongPolls
      this.peakLongPollsAt = new Date().toISOString()
    }
    if (longPoll === 'ask') {
      this.activeAskLongPolls += 1
    } else if (longPoll === 'browser-host') {
      this.activeBrowserHostLongPolls += 1
      if (pairedDeviceId !== undefined) {
        this.activeBrowserHostLongPollsByDevice.set(
          pairedDeviceId,
          (this.activeBrowserHostLongPollsByDevice.get(pairedDeviceId) ?? 0) + 1
        )
      }
    }
    return null
  }

  // Why: the refusal is answered before any handler runs, so this counter and
  // the warn are the whole audit trail — nothing downstream will record that
  // the request existed. The message carries the occupancy that refused it.
  private refuseLongPoll(longPoll: RuntimeLongPollClass, reason: string): string {
    const now = new Date()
    this.longPollRefusals[longPoll] += 1
    this.lastLongPollRefusalAt = now.toISOString()
    const report = this.longPollCapacityReport()
    const nowMs = now.getTime()
    if (nowMs - this.lastLongPollRefusalWarnMs[longPoll] >= LONG_POLL_REFUSAL_WARN_INTERVAL_MS) {
      this.lastLongPollRefusalWarnMs[longPoll] = nowMs
      console.warn(
        `[runtime] Refused a ${longPoll} long-poll: ${reason}. Held ${report.held}/${report.cap} ` +
          `(${report.heldByClass.wait} wait, ${report.heldByClass.ask} ask, ` +
          `${report.heldByClass['browser-host']} browser-host); ` +
          `${this.longPollRefusals[longPoll]} ${longPoll} refusal(s) since start.`
      )
    }
    return describeLongPollRefusal(reason, report)
  }

  protected longPollCapacityReport(): LongPollCapacityReport {
    return {
      cap: this.longPollCap,
      held: this.activeLongPolls,
      heldByClass: {
        ask: this.activeAskLongPolls,
        'browser-host': this.activeBrowserHostLongPolls,
        wait: Math.max(
          0,
          this.activeLongPolls - this.activeAskLongPolls - this.activeBrowserHostLongPolls
        )
      },
      peakHeld: this.peakLongPolls,
      peakHeldAt: this.peakLongPollsAt,
      refusedByClass: { ...this.longPollRefusals },
      lastRefusalAt: this.lastLongPollRefusalAt
    }
  }

  protected releaseLongPoll(longPoll: RuntimeLongPollClass | null, pairedDeviceId?: string): void {
    if (!longPoll) {
      return
    }
    this.activeLongPolls = Math.max(0, this.activeLongPolls - 1)
    if (longPoll === 'ask') {
      this.activeAskLongPolls = Math.max(0, this.activeAskLongPolls - 1)
    } else if (longPoll === 'browser-host') {
      this.activeBrowserHostLongPolls = Math.max(0, this.activeBrowserHostLongPolls - 1)
      if (pairedDeviceId !== undefined) {
        const remaining = (this.activeBrowserHostLongPollsByDevice.get(pairedDeviceId) ?? 1) - 1
        if (remaining > 0) {
          this.activeBrowserHostLongPollsByDevice.set(pairedDeviceId, remaining)
        } else {
          this.activeBrowserHostLongPollsByDevice.delete(pairedDeviceId)
        }
      }
    }
  }

  protected parseAndAuth(rawMessage: string): { request: RpcRequest } | { error: RpcResponse } {
    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      return { error: this.buildError('unknown', 'bad_request', 'Invalid JSON request') }
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      return { error: this.buildError('unknown', 'bad_request', 'Missing request id') }
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      return { error: this.buildError(request.id, 'bad_request', 'Missing RPC method') }
    }
    if (typeof request.authToken !== 'string' || request.authToken.length === 0) {
      return { error: this.buildError(request.id, 'unauthorized', 'Missing auth token') }
    }
    if (request.authToken !== this.authToken) {
      return { error: this.buildError(request.id, 'unauthorized', 'Invalid auth token') }
    }

    return { request }
  }

  protected buildError(id: string, code: string, message: string): RpcResponse {
    return errorResponse(id, { runtimeId: this.runtime.getRuntimeId() }, code, message)
  }

  protected writeMetadata(): void {
    const metadata: RuntimeMetadata = {
      runtimeId: this.runtime.getRuntimeId(),
      pid: this.pid,
      transports: this.transports,
      authToken: this.authToken,
      startedAt: this.runtime.getStartedAt()
    }
    writeRuntimeMetadata(this.userDataPath, metadata)
  }
}
