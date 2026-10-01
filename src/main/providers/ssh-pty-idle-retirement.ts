import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import {
  advertisesPtyIdleRetirement,
  parsePtyIdleRetirementResult,
  retainPty,
  type PtyIdleRetirementRequest,
  type PtyIdleRetirementResult
} from '../../shared/pty-idle-retirement'

// Why: sequential relay teardown calls share one absolute budget; convert to the mux-relative timeout only at dispatch.
export function relayTimeoutOptions(
  deadlineMs: number | undefined
): { timeoutMs: number } | undefined {
  return deadlineMs === undefined ? undefined : { timeoutMs: Math.max(1, deadlineMs - Date.now()) }
}

/**
 * Ask the relay to retire one PTY under its own enforcement. A relay that does not advertise the
 * contract retains the pane: an older relay would treat any stop as unconditional teardown. The
 * owner claim is this client's persisted consumer identity; the relay checks it against both the
 * connection's grant and its own creator record.
 */
export async function requestSshPtyIdleRetirement(args: {
  mux: Pick<SshChannelMultiplexer, 'request'>
  relayPtyId: string
  ownerClientInstanceId: string | null
  request: PtyIdleRetirementRequest
}): Promise<PtyIdleRetirementResult> {
  const { mux, relayPtyId, ownerClientInstanceId, request } = args
  const timeout = relayTimeoutOptions(request.deadlineMs)
  let capabilities: unknown
  try {
    capabilities = await mux.request('pty.getCapabilities', undefined, timeout)
  } catch {
    // Nothing was asked of the PTY yet, so the pane is untouched.
    return retainPty('unverifiable')
  }
  if (!advertisesPtyIdleRetirement(capabilities)) {
    return retainPty('unsupported')
  }
  const { expectedIncarnationId, expectedOutputChars } = request
  let reply: unknown
  try {
    reply = await mux.request(
      'pty.retireIdle',
      {
        id: relayPtyId,
        expectedIncarnationId,
        ...(ownerClientInstanceId === null
          ? {}
          : { expectedOwnerClientInstanceId: ownerClientInstanceId }),
        ...(expectedOutputChars === undefined ? {} : { expectedOutputChars })
      },
      timeout
    )
  } catch {
    // The host may have acted before the reply was lost; never read this as retained or absent.
    return { outcome: 'unconfirmed' }
  }
  return parsePtyIdleRetirementResult(reply) ?? { outcome: 'unconfirmed' }
}
