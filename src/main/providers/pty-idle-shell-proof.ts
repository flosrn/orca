import { buildProcessTableIndex } from '../../shared/process-table-index'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS } from '../../shared/ssh-relay-pty-ownership-proof'
import type { PtyIdleRetirementRetainReason } from '../../shared/pty-idle-retirement'
import { resolveAgentForegroundProcessesFromIndex } from './agent-foreground-process-batch'

/** Oldest process-table capture that may authorize an automatic retirement stop. */
export const PTY_IDLE_RETIREMENT_MAX_EVIDENCE_AGE_MS = RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS

export type ProcessTableCapture = { rows: readonly ProcessTableRow[]; capturedAgeMs: number }

export type IdleShellProofOptions = {
  /** From the host's spawn record (never a row's name): the root is the macOS `/usr/bin/login`
   *  TCC wrapper, which forks the shell as its only child instead of exec'ing it. */
  rootIsLoginWrapper?: boolean
}

/**
 * Reduces a login-wrapped capture to the shell's own. Sound only because the wrapper is proven to
 * add nothing to the stop's reach: its process group holds just itself, it is not stopped, and its
 * only child is the shell leading its own group. Null when that structure is absent.
 */
function unwrapLoginShell(
  rootPid: number,
  rows: readonly ProcessTableRow[]
): { shellPid: number; rows: readonly ProcessTableRow[] } | null {
  const wrapper = rows.find((row) => row.pid === rootPid)
  const children = rows.filter((row) => row.ppid === rootPid)
  const shell = children[0]
  if (
    !wrapper ||
    wrapper.pgid === undefined ||
    /T/.test(wrapper.stat) ||
    children.length !== 1 ||
    shell.pgid !== shell.pid ||
    rows.filter((row) => row.pgid === wrapper.pgid).length !== 1
  ) {
    return null
  }
  return { shellPid: shell.pid, rows: rows.filter((row) => row !== wrapper) }
}

/**
 * Whether one POSIX process-table capture proves the PTY holds a bare shell and nothing an
 * immediate stop would reach. Null means proven idle; otherwise the retain reason.
 *
 * Measured in the stop's own units (docs/reference/ssh-execution-boundary.md): every tty process
 * group is the shell's, none stopped, the shell's group has no other member anywhere, AND the
 * shell has no child at all — a `setsid` service leaves both the tty and the group but is still
 * inside the immediate stop's descendant sweep.
 */
export function refuteIdleShell(
  rootPid: number,
  capture: ProcessTableCapture,
  options: IdleShellProofOptions = {}
): PtyIdleRetirementRetainReason | null {
  if (capture.capturedAgeMs > PTY_IDLE_RETIREMENT_MAX_EVIDENCE_AGE_MS) {
    return 'evidence_stale'
  }
  const target = options.rootIsLoginWrapper
    ? unwrapLoginShell(rootPid, capture.rows)
    : { shellPid: rootPid, rows: capture.rows }
  if (!target) {
    return 'not_idle'
  }
  const [observed] = resolveAgentForegroundProcessesFromIndex(buildProcessTableIndex(target.rows), [
    { rootPid: target.shellPid }
  ])
  if (!observed?.available || observed.shellOwnsEveryTtyProcessGroup === undefined) {
    return 'unverifiable'
  }
  const idle =
    observed.shellOwnsEveryTtyProcessGroup &&
    !target.rows.some((row) => row.ppid === target.shellPid)
  return idle ? null : 'not_idle'
}
