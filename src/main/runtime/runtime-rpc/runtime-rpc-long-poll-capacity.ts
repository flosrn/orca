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
// it. Prefix and the "retry with backoff" suffix stay intact: recoverability is
// classified off that fragment.
export function describeLongPollRefusal(reason: string, report: LongPollCapacityReport): string {
  const held = report.heldByClass
  return (
    `${reason} (held ${report.held}/${report.cap}: ` +
    `${held.wait} wait, ${held.ask} ask, ${held['browser-host']} browser-host); retry with backoff`
  )
}
