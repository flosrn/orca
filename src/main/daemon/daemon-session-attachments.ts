import { performance } from 'node:perf_hooks'
import type { TerminalHost } from './terminal-host'

/** Per-session activity revisions; idle retirement refuses when any moves while it inspects. */
export type DaemonSessionActivity = { input: number; output: number; bind: number }

export class DaemonSessionAttachments {
  private readonly clientIdBySessionId = new Map<string, string>()
  private readonly tokenBySessionId = new Map<string, symbol>()
  private readonly lastInputAtBySessionId = new Map<string, number>()
  private readonly activityBySessionId = new Map<string, DaemonSessionActivity>()

  constructor(private readonly host: TerminalHost) {}

  attach(sessionId: string, clientId: string, token: symbol): void {
    this.clientIdBySessionId.set(sessionId, clientId)
    this.tokenBySessionId.set(sessionId, token)
    this.touchActivity(sessionId).bind += 1
  }

  clientIdForSession(sessionId: string): string | undefined {
    return this.clientIdBySessionId.get(sessionId)
  }

  recordInput(sessionId: string): void {
    this.lastInputAtBySessionId.set(sessionId, performance.now())
    this.touchActivity(sessionId).input += 1
  }

  recordOutput(sessionId: string): void {
    this.touchActivity(sessionId).output += 1
  }

  activity(sessionId: string): Readonly<DaemonSessionActivity> {
    return { ...this.touchActivity(sessionId) }
  }

  private touchActivity(sessionId: string): DaemonSessionActivity {
    let activity = this.activityBySessionId.get(sessionId)
    if (!activity) {
      activity = { input: 0, output: 0, bind: 0 }
      this.activityBySessionId.set(sessionId, activity)
    }
    return activity
  }

  lastInputAt(sessionId: string): number | undefined {
    return this.lastInputAtBySessionId.get(sessionId)
  }

  clearInput(sessionId: string): void {
    this.lastInputAtBySessionId.delete(sessionId)
  }

  release(sessionId: string): void {
    this.clientIdBySessionId.delete(sessionId)
    this.tokenBySessionId.delete(sessionId)
    this.lastInputAtBySessionId.delete(sessionId)
    this.activityBySessionId.delete(sessionId)
  }

  detachSessionForClient(sessionId: string, clientId: string): void {
    if (this.clientIdBySessionId.get(sessionId) !== clientId) {
      return
    }
    const token = this.tokenBySessionId.get(sessionId)
    if (token) {
      this.host.detach(sessionId, token)
    }
    this.clientIdBySessionId.delete(sessionId)
    this.tokenBySessionId.delete(sessionId)
  }

  detachClientSessions(clientId: string): void {
    const attachments: { sessionId: string; token: symbol }[] = []
    for (const [sessionId, attachedClientId] of this.clientIdBySessionId) {
      if (attachedClientId !== clientId) {
        continue
      }
      const token = this.tokenBySessionId.get(sessionId)
      if (token) {
        attachments.push({ sessionId, token })
      }
      this.clientIdBySessionId.delete(sessionId)
      this.tokenBySessionId.delete(sessionId)
    }
    if (attachments.length > 0) {
      this.host.detachClients(attachments)
    }
  }
}
