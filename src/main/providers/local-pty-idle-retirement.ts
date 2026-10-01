import type * as pty from 'node-pty'
import { getStrictProcessTableSnapshotStartedAfterRequest } from '../../shared/process-table-snapshot-reader'
import {
  retainPty,
  type PtyIdleRetirementRequest,
  type PtyIdleRetirementResult
} from '../../shared/pty-idle-retirement'
import { readLocalPtyActivity } from './local-pty-activity'
import {
  ptyIncarnations,
  ptyReportsChildExitStatus,
  ptyProcesses,
  ptyShutdownOperations,
  ptyTerminationMode
} from './local-pty-provider-state'
import { shutdownLocalPty } from './local-pty-termination'
import { refuteIdleShell, type ProcessTableCapture } from './pty-idle-shell-proof'

export type LocalPtyIdleRetirementEnvironment = {
  readProcessTable?: () => Promise<ProcessTableCapture>
  platform?: NodeJS.Platform
}

const pendingRetirements = new Set<string>()

function refuteLocalPty(
  id: string,
  proc: pty.IPty,
  expectedIncarnationId: string
): PtyIdleRetirementResult | null {
  if (ptyProcesses.get(id) !== proc || ptyIncarnations.get(id) !== expectedIncarnationId) {
    return retainPty('incarnation_mismatch')
  }
  if (ptyShutdownOperations.has(id) || ptyTerminationMode.has(id)) {
    return retainPty('terminating')
  }
  return null
}

/**
 * Automatic preparation retirement for PTYs this process owns: decide after the capture, in one
 * step, that the exact incarnation is unchanged, received no input, output or reattach, and holds
 * a bare shell.
 */
export async function retireLocalPtyIdle(
  id: string,
  request: PtyIdleRetirementRequest,
  environment: LocalPtyIdleRetirementEnvironment = {}
): Promise<PtyIdleRetirementResult> {
  const proc = ptyProcesses.get(id)
  if (!proc) {
    return retainPty('unverifiable')
  }
  const { expectedIncarnationId } = request
  const before = refuteLocalPty(id, proc, expectedIncarnationId)
  if (before) {
    return before
  }
  if (pendingRetirements.has(id)) {
    return retainPty('retirement_in_progress')
  }
  if ((environment.platform ?? process.platform) === 'win32') {
    // No foreground primitive, and orphaned grandchildren stay in the ConPTY job the stop reaches.
    return retainPty('unverifiable')
  }
  const fence = readLocalPtyActivity(id)
  pendingRetirements.add(id)
  let capture: ProcessTableCapture
  try {
    capture = await (
      environment.readProcessTable ?? getStrictProcessTableSnapshotStartedAfterRequest
    )()
  } catch {
    return retainPty('unverifiable')
  } finally {
    pendingRetirements.delete(id)
  }
  const after = refuteLocalPty(id, proc, expectedIncarnationId)
  if (after) {
    return after
  }
  const activity = readLocalPtyActivity(id)
  if (activity.input !== fence.input) {
    return retainPty('input_during_inspection')
  }
  if (activity.bind !== fence.bind) {
    return retainPty('rebind_during_inspection')
  }
  if (activity.output !== fence.output) {
    return retainPty('output_during_inspection')
  }
  // The spawn record, never a process-table name, says the root is the macOS login wrapper.
  const reason = refuteIdleShell(proc.pid, capture, {
    rootIsLoginWrapper: ptyReportsChildExitStatus.get(id) === false
  })
  if (reason) {
    return retainPty(reason)
  }
  try {
    await shutdownLocalPty(id, { immediate: true })
  } catch {
    return { outcome: 'unconfirmed' }
  }
  return { outcome: 'stopped' }
}
