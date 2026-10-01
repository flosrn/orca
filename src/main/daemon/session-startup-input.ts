import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { SessionOptions } from './session-options'
import type { SessionOutputPlane } from './session-output-plane'
import { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'

/**
 * The session's startup input path: the shell-ready barrier that holds early writes, and the
 * startup ingress that delivers the launch command and answers terminal queries. Built together
 * because each forwards to the other.
 */
export function createSessionStartupInput(args: {
  sessionId: string
  subprocess: SubprocessHandle
  output: SessionOutputPlane
  recoveryBarrier: TerminalShellRecoveryBarrier
  opts: SessionOptions
}): { shellReady: SessionShellReadyBarrier; startupIngress: PtyStartupIngress } {
  const { sessionId, subprocess, output, recoveryBarrier, opts } = args
  let startupIngress: PtyStartupIngress | null = null
  const shellReady = new SessionShellReadyBarrier({
    sessionId,
    subprocess,
    responderParser: output.responderParser,
    shellReadySupported: opts.shellReadySupported,
    ...(opts.reportReadinessEvent ? { reportReadinessEvent: opts.reportReadinessEvent } : {}),
    shellReadyTimeoutMs: opts.shellReadyTimeoutMs,
    installDeviceAttributesFilter: () => output.installDeviceAttributesFilter(),
    releaseDeviceAttributesFilter: () => output.releaseDeviceAttributesFilter(),
    acceptStartupIngress: (data) => startupIngress!.accept(data)
  })
  startupIngress = new PtyStartupIngress({
    ...(opts.startupIngress ? { intent: opts.startupIngress } : {}),
    ...(opts.ownerBackend ? { ownerBackend: opts.ownerBackend } : {}),
    write: (data) => subprocess.write(data),
    onEmission: (emission) => recoveryBarrier.accept(emission)
  })
  return { shellReady, startupIngress }
}
