import { isPreparationSpawnIntake } from '../../../../shared/preparation-contracts'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { PtyIpcSpawnState } from './spawn-state'

type PaneIdentity = { tabId: string | null; leafId: string | null; paneKey: string | null }

// Why: the tab/leaf come from the pane key this handler already validated against the IPC
// metadata, never from a title or path the renderer could reuse for another pane.
function spawnPaneIdentity(ctx: PtyIpcSpawnState): PaneIdentity {
  const paneKey = ctx.reservationPaneKey
  const parsed = paneKey ? parsePaneKey(paneKey) : null
  return parsed
    ? { tabId: parsed.tabId, leafId: parsed.leafId, paneKey }
    : { tabId: null, leafId: null, paneKey: null }
}

function spawnWorktreeId(ctx: PtyIpcSpawnState): string | null {
  const worktreeId = ctx.args.worktreeId
  return typeof worktreeId === 'string' && worktreeId.length > 0 ? worktreeId : null
}

/** Arms the preparation role before the provider can emit a byte; a refusal spawns unowned. */
export function reservePtyIpcSpawnPreparation(ctx: PtyIpcSpawnState): void {
  const intake = ctx.args.preparation
  const runtime = ctx.deps.runtime
  const worktreeId = spawnWorktreeId(ctx)
  // Why: a pre-adopted stable pane already spawned before this point, so arming now could not
  // precede its first byte; it stays unowned rather than adopted after the fact.
  if (!isPreparationSpawnIntake(intake) || !runtime || !worktreeId || ctx.preAdoptedStablePane) {
    return
  }
  // Why: a deferred renderer command for a tombstoned preparation must never rerun its setup
  // or restore its retired leaf on activation or remount.
  if (intake.role === 'preparation' && !runtime.mayEnqueuePreparationSetup(intake.preparationId)) {
    throw new Error('preparation_retired')
  }
  // Why: a local-provider spawn learns its handle only inside the provider, so an unknown
  // handle gets a fresh token that only scopes releasing this reservation.
  const handle = ctx.preAllocatedHandle ?? runtime.createPreAllocatedTerminalHandle()
  const { tabId, leafId } = spawnPaneIdentity(ctx)
  const reservedIntake = { preparationId: intake.preparationId, role: intake.role }
  if (runtime.reservePreparationPane(reservedIntake, worktreeId, { handle, tabId, leafId })) {
    ctx.preparationReservation = { intake: reservedIntake, handle }
  }
}

/** Binds the acknowledged fresh incarnation; a reattached process never inherits the role. */
export function bindPtyIpcSpawnPreparation(ctx: PtyIpcSpawnState): void {
  const reservation = ctx.preparationReservation
  const runtime = ctx.deps.runtime
  const worktreeId = spawnWorktreeId(ctx)
  if (!reservation || !runtime || !worktreeId || ctx.result.isReattach === true) {
    return
  }
  runtime.bindPreparationPane(reservation.intake, worktreeId, {
    handle: ctx.stablePaneOwner?.handle ?? runtime.preAllocateHandleForPty(ctx.result.id),
    ptyId: ctx.result.id,
    incarnationId: ctx.result.incarnationId ?? null,
    ...spawnPaneIdentity(ctx)
  })
}

/** Drops a reservation no acknowledged spawn bound; a no-op once the role is bound. */
export function releasePtyIpcSpawnPreparation(ctx: PtyIpcSpawnState): void {
  const reservation = ctx.preparationReservation
  ctx.preparationReservation = null
  if (reservation) {
    ctx.deps.runtime?.releasePreparationPane(reservation.intake, reservation.handle)
  }
}
