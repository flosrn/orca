import type { RuntimeLongPollClass } from './runtime-rpc-long-poll'

export type LongPollCapacityReport = {
  cap: number
  held: number
  heldByClass: Record<RuntimeLongPollClass, number>
  peakHeld: number
  peakHeldAt: string | null
  refusedByClass: Record<RuntimeLongPollClass, number>
  lastRefusalAt: string | null
}

type LongPollCapacityProbe = () => LongPollCapacityReport

// Why: a refused long-poll is answered before any handler runs, so it writes no
// mutation receipt, no dispatch row and no stage — the runtime's own store
// cannot tell "refused at the fence" from "never called". Measured on the
// 2026-09-02 orchestration wave: 67 min at 16/16 with no trace anywhere, and
// the resulting 23-min dispatch gap was attributed to a launch queue that does
// not exist. This probe is that missing trace; status.get publishes it.
// Keyed by runtime id, not a bare singleton: tests run several servers per
// process and must not read each other's counters.
const probesByRuntimeId = new Map<string, LongPollCapacityProbe>()

export function publishLongPollCapacityProbe(
  runtimeId: string,
  probe: LongPollCapacityProbe
): void {
  probesByRuntimeId.set(runtimeId, probe)
}

export function retireLongPollCapacityProbe(runtimeId: string): void {
  probesByRuntimeId.delete(runtimeId)
}

export function getLongPollCapacityReport(runtimeId: string): LongPollCapacityReport | null {
  return probesByRuntimeId.get(runtimeId)?.() ?? null
}

// Why: "capacity reached" alone cannot tell a legitimate worker fleet parking
// `check --wait` from leaked slots held by reaped processes — the refused
// client, which is usually the only witness, needs the occupancy that refused
// it.
//
// This is published content on an existing path, so rule 3 of
// docs/reference/remote-wire-compatibility.md applies: it grants nothing, it
// asks whether an old client can still interpret the new content. Every reader
// of a `runtime_busy` failure was checked, and none of them parses this prose.
// isBrowserHostAdmissionCapacityError reads `.code` only.
// isRecoverableRemoteRuntimeConnectionError and isRuntimeRpcQueueOverloadError
// treat a present code as authoritative and consult their message fragments
// only for an error carrying no code — and neither list holds this text.
// Mobile's classifyWorktreeShowResponse does parse prose, but only for
// `runtime_error`; any other code, this one included, returns 'unknown' before
// the message is read, and the token it hunts is `selector_not_found`.
// So the prefix and the "retry with backoff" tail stay for the human or agent
// reading them, and a future reader that keys on this text has to negotiate it
// rather than assume it.
export function describeLongPollRefusal(reason: string, report: LongPollCapacityReport): string {
  const held = report.heldByClass
  return (
    `${reason} (held ${report.held}/${report.cap}: ` +
    `${held.wait} wait, ${held.ask} ask, ${held['browser-host']} browser-host); retry with backoff`
  )
}
