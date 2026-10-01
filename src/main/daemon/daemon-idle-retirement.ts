import { getStrictProcessTableSnapshotStartedAfterRequest } from '../../shared/process-table-snapshot-reader'
import { retainPty, type PtyIdleRetirementResult } from '../../shared/pty-idle-retirement'
import { refuteIdleShell, type ProcessTableCapture } from '../providers/pty-idle-shell-proof'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import type { TerminalHost } from './terminal-host'
import type { RetireIdleRequest, SessionInfo } from './types'

export type DaemonIdleRetirementTarget = {
  host: Pick<TerminalHost, 'listSessions' | 'isKilled' | 'sessionRootIsLoginWrapper'>
  attachments: Pick<DaemonSessionAttachments, 'activity'>
  /** Immediate stop through the router's ordinary kill path; resolves once the root has exited. */
  stop: () => Promise<unknown>
}

export type DaemonIdleRetirementEnvironment = {
  readProcessTable?: () => Promise<ProcessTableCapture>
  platform?: NodeJS.Platform
}

/**
 * Local-host half of automatic preparation retirement. The daemon owns the session, so it alone
 * can decide in one step, after the capture, that the exact incarnation is unchanged, received no
 * input, output or attach, and holds a bare shell — then stop it. Anything short of that retains
 * the session.
 */
export class DaemonIdleRetirement {
  private readonly pending = new Set<string>()

  constructor(private readonly environment: DaemonIdleRetirementEnvironment = {}) {}

  async retire(
    payload: RetireIdleRequest['payload'],
    target: DaemonIdleRetirementTarget
  ): Promise<PtyIdleRetirementResult> {
    const { sessionId, expectedIncarnationId } = payload
    if (typeof expectedIncarnationId !== 'string' || expectedIncarnationId.length === 0) {
      throw new Error('Invalid retireIdle request')
    }
    const before = this.refuteSession(target, sessionId, expectedIncarnationId)
    if (!('pid' in before)) {
      return before
    }
    if (this.pending.has(sessionId)) {
      return retainPty('retirement_in_progress')
    }
    if ((this.environment.platform ?? process.platform) === 'win32') {
      // No foreground primitive, and orphaned grandchildren stay in the ConPTY job the stop reaches.
      return retainPty('unverifiable')
    }
    const fence = target.attachments.activity(sessionId)
    this.pending.add(sessionId)
    let capture: ProcessTableCapture
    try {
      capture = await (
        this.environment.readProcessTable ?? getStrictProcessTableSnapshotStartedAfterRequest
      )()
    } catch {
      this.pending.delete(sessionId)
      return retainPty('unverifiable')
    }
    this.pending.delete(sessionId)
    const after = this.refuteSession(target, sessionId, expectedIncarnationId)
    if (!('pid' in after)) {
      return after
    }
    const activity = target.attachments.activity(sessionId)
    if (activity.input !== fence.input) {
      return retainPty('input_during_inspection')
    }
    if (activity.bind !== fence.bind) {
      return retainPty('rebind_during_inspection')
    }
    if (activity.output !== fence.output) {
      return retainPty('output_during_inspection')
    }
    const reason = refuteIdleShell(after.pid, capture, {
      rootIsLoginWrapper: target.host.sessionRootIsLoginWrapper(sessionId)
    })
    if (reason) {
      return retainPty(reason)
    }
    try {
      await target.stop()
    } catch {
      return { outcome: 'unconfirmed' }
    }
    return { outcome: 'stopped' }
  }

  private refuteSession(
    target: DaemonIdleRetirementTarget,
    sessionId: string,
    expectedIncarnationId: string
  ): PtyIdleRetirementResult | { pid: number } {
    const session: SessionInfo | undefined = target.host
      .listSessions()
      .find((candidate) => candidate.sessionId === sessionId && candidate.isAlive)
    if (!session) {
      // Absence from the live map is not an exit record for this incarnation.
      return retainPty('unverifiable')
    }
    if (session.incarnationId !== expectedIncarnationId) {
      return retainPty('incarnation_mismatch')
    }
    if (target.host.isKilled(sessionId)) {
      return retainPty('terminating')
    }
    return session.pid === null ? retainPty('unverifiable') : { pid: session.pid }
  }
}
