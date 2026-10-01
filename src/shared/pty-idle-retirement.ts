import { z } from 'zod'

/**
 * Automatic-cleanup stop, enforced by the execution host that owns the PTY.
 *
 * Unlike `shutdown`, which is unconditional teardown, the host decides here: it stops the PTY only
 * when it still holds the exact incarnation the caller recorded, attests the caller as its creator
 * (remote hosts), saw no input, output or rebind while it inspected, and observed a bare shell with
 * nothing the stop would reach. Every other answer retains the pane.
 */

/** Advertised by relays (`pty.getCapabilities.idleRetirementVersion`) that enforce this contract. */
export const PTY_IDLE_RETIREMENT_VERSION = 1

export const PTY_IDLE_RETIREMENT_RETAIN_REASONS = [
  /** The provider or host cannot enforce this contract; never fall back to `shutdown`. */
  'unsupported',
  'incarnation_mismatch',
  /** The host did not record this caller as the PTY's creator, or the connection is not it. */
  'owner_unattested',
  'terminating',
  'retirement_in_progress',
  /** The host emitted output the caller had not received when it asked. */
  'output_advanced',
  'input_during_inspection',
  'output_during_inspection',
  'rebind_during_inspection',
  'evidence_stale',
  /** Something besides the bare shell is running, suspended, or within the stop's reach. */
  'not_idle',
  /** The host could not observe the PTY's processes (unreadable table, no foreground primitive). */
  'unverifiable'
] as const

export type PtyIdleRetirementRetainReason = (typeof PTY_IDLE_RETIREMENT_RETAIN_REASONS)[number]

export type PtyIdleRetirementResult =
  /** The host stopped the exact incarnation and observed its physical exit. */
  | { outcome: 'stopped' }
  /** The exact incarnation had already exited, per the host's own exit record. */
  | { outcome: 'exited' }
  /** The host signalled the stop but did not observe exit; the PTY must not be treated as absent. */
  | { outcome: 'unconfirmed' }
  | { outcome: 'retained'; reason: PtyIdleRetirementRetainReason }

export type PtyIdleRetirementRequest = {
  expectedIncarnationId: string
  /** Output characters the caller has received from this incarnation (live data, not replay).
   *  Only relay hosts enforce it; daemon and in-process providers fence output that lands while
   *  they inspect, not output emitted before the request. */
  expectedOutputChars?: number
  /** Absolute epoch ms bounding the request. */
  deadlineMs?: number
}

export function retainPty(reason: PtyIdleRetirementRetainReason): PtyIdleRetirementResult {
  return { outcome: 'retained', reason }
}

const PtyIdleRetirementReply = z.union([
  z.object({ outcome: z.enum(['stopped', 'exited', 'unconfirmed']) }),
  z.object({ outcome: z.literal('retained'), reason: z.enum(PTY_IDLE_RETIREMENT_RETAIN_REASONS) })
])

/** Validates a host answer; null means the reply carried no usable outcome. */
export function parsePtyIdleRetirementResult(value: unknown): PtyIdleRetirementResult | null {
  const parsed = PtyIdleRetirementReply.safeParse(value)
  if (!parsed.success) {
    return null
  }
  return parsed.data.outcome === 'retained'
    ? retainPty(parsed.data.reason)
    : { outcome: parsed.data.outcome }
}

const RelayIdleRetirementCapability = z.object({
  idleRetirementVersion: z.literal(PTY_IDLE_RETIREMENT_VERSION)
})

/** True only when a relay's capability reply advertises this retirement contract. */
export function advertisesPtyIdleRetirement(capabilities: unknown): boolean {
  return RelayIdleRetirementCapability.safeParse(capabilities).success
}
