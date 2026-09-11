import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'
import { logClaudeAuthDiagnostic } from '../rate-limits/claude-auth-diagnostics-log'
import { isClaudeLivePtyGateHeld, markClaudePtyExited } from './live-pty-gate'

/**
 * PTY liveness is not Claude liveness.
 *
 * The gate is held by a PTY id, but what it protects is a running `claude`
 * reading a credential file. A pane whose Claude exited back to its shell — or
 * that now runs a different agent — keeps the same daemon session alive, so the
 * PTY-exit path never fires and the gate stays closed for the life of the pane:
 * the managed OAuth refresh is deferred forever and a legacy-session migration
 * is refused forever.
 *
 * Releases here come from a foreground observation, and only from one that
 * PROVES Claude is gone. Anything less keeps the gate: an `unverifiable` or
 * `exited` verdict, an answer carrying no evidence (an old host, or a
 * steady-state cheap tick that did not pay for a capture), and any foreground
 * that could still be a Claude — `claude` itself, or an unrecognized command
 * such as a bare interpreter.
 */

/**
 * Where the observation came from, which decides whether an empty pane is proof.
 *
 * A launch marks the gate at spawn, before the CLI has execed, so a pane this
 * process just launched Claude into legitimately reads as its bare shell for a
 * moment — releasing on that would rotate the refresh token out from under the
 * Claude about to start, the exact race the gate exists for. `steady-state`
 * therefore accepts an empty pane only after it has seen Claude in it.
 * `startup-reconcile` runs against sessions restored from a previous process,
 * where no launch of ours can be in flight.
 */
export type ClaudeGateReleaseOrigin = 'startup-reconcile' | 'steady-state'

// Why: keyed by gate id and dropped both on release and on any id the gate no
// longer holds, so this never outlives the panes the gate itself tracks.
const panesObservedRunningClaude = new Set<string>()

/** The name logged when the host proved the pane holds no agent and no command. */
const EMPTY_PANE_FOREGROUND = 'shell'

export function releaseClaudeLivePtyOnNonClaudeForeground(
  ptyId: string,
  inspection: TerminalProcessInspection,
  origin: ClaudeGateReleaseOrigin
): boolean {
  if (!isClaudeLivePtyGateHeld(ptyId)) {
    panesObservedRunningClaude.delete(ptyId)
    return false
  }
  const evidence = inspection.foregroundProcessEvidence
  const live = evidence?.verdict === 'live'
  // Evidence names recognized agents only; the compatibility field carries an
  // ordinary command, and a cheap tick carries the name with no evidence at all.
  const observed = (live ? evidence.processName : null) ?? inspection.foregroundProcess
  if (observed !== null && recognizeAgentProcess(observed)?.agent === 'claude') {
    panesObservedRunningClaude.add(ptyId)
    return false
  }
  if (!live) {
    return false
  }
  const foreground = releasableForeground(ptyId, observed, origin)
  if (foreground === null) {
    return false
  }
  panesObservedRunningClaude.delete(ptyId)
  markClaudePtyExited(ptyId)
  logClaudeAuthDiagnostic('claude-live-pty-gate-released-foreground', { ptyId, foreground })
  return true
}

/** The foreground name to log, or null when a live observation is still not proof. */
function releasableForeground(
  ptyId: string,
  observed: string | null,
  origin: ClaudeGateReleaseOrigin
): string | null {
  if (observed === null || isShellProcess(observed)) {
    // A live verdict is a read of this pane's own process subtree, so naming
    // nothing there means the shell owns the pane — which the host reports as a
    // null name. Proof that Claude LEFT only once we know it was ever there.
    if (origin !== 'startup-reconcile' && !panesObservedRunningClaude.has(ptyId)) {
      return null
    }
    return observed ?? EMPTY_PANE_FOREGROUND
  }
  // Another recognized agent owns the pane: whatever else is true, it is not a
  // Claude this process launched and is still waiting on. An unrecognized
  // command could be one, so it proves nothing.
  return recognizeAgentProcess(observed)?.processName ?? null
}
