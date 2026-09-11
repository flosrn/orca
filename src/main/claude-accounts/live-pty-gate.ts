import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import type { ClaudeLivePtyBindingEntry } from '../../shared/persisted-state-types'

const liveClaudePtyIds = new Set<string>()
// Why: ids restored from persistence at startup, not yet confirmed against the
// daemon. They keep the OAuth refresh gate closed so an early managed refresh
// cannot rotate the single-use refresh token out from under a Claude CLI that
// survived the app restart inside the daemon.
const seededUnconfirmedPtyIds = new Set<string>()
let switchInProgress = false
// Woken by endClaudeAuthSwitch so a caller past the point of no return can wait the
// swap out instead of refusing. See whenClaudeAuthSwitchSettles.
const switchSettledListeners = new Set<() => void>()

/** A managed account swap is a credential-file rewrite, not a network round trip;
 *  anything past this is a wedged switch, and refusing beats waiting forever. */
export const CLAUDE_AUTH_SWITCH_SETTLE_TIMEOUT_MS = 15_000

/**
 * Which credential surface a live Claude owns.
 *
 * `account-dir` is a host managed account pinned to its own CLAUDE_CONFIG_DIR:
 * it owns that account's credentials and nothing else. `shared-dir` is the
 * user's own ~/.claude. `unknown` is a session whose binding this process
 * cannot prove — a pane restored from persistence before its record was read,
 * or one spawned by a build that predates per-account pinning. An unknown
 * session is treated as owning the SHARED surface (it may well be reading it)
 * but never as owning any particular account, so it cannot block every
 * account's refresh the way a single global gate did.
 */
export type ClaudeLivePtyBinding =
  | { route: 'account-dir'; accountId: string }
  | { route: 'wsl-dir'; accountId: string | null }
  | { route: 'shared-dir' }
  | { route: 'unknown' }

export const UNKNOWN_CLAUDE_LIVE_PTY_BINDING: ClaudeLivePtyBinding = { route: 'unknown' }

const bindingByGateId = new Map<string, ClaudeLivePtyBinding>()

/**
 * The binding a spawn should record, derived from the auth preparation it
 * actually launched with. A launch with no preparation (no managed-account
 * wiring) is `unknown`, which keeps the shared surface protected without
 * claiming an account.
 */
export function claudeLivePtyBindingForPreparation(
  preparation: ClaudeRuntimeAuthPreparation | null | undefined
): ClaudeLivePtyBinding {
  if (!preparation) {
    return UNKNOWN_CLAUDE_LIVE_PTY_BINDING
  }
  if (preparation.configDirRoute === 'account-dir' && preparation.accountId) {
    return { route: 'account-dir', accountId: preparation.accountId }
  }
  if (preparation.configDirRoute === 'wsl-dir') {
    return { route: 'wsl-dir', accountId: preparation.accountId ?? null }
  }
  return preparation.configDirRoute === 'shared-dir'
    ? { route: 'shared-dir' }
    : UNKNOWN_CLAUDE_LIVE_PTY_BINDING
}

/**
 * The binding a row restored from persistence seeds the gate with.
 *
 * Fails closed on an unattributable row: an `account-dir` entry that names no
 * account matches no account in `hasLiveClaudePtysForAccount` and is excluded
 * from `hasLiveClaudeSessionsOnSharedSurface`, so seeding it as written would
 * protect nothing. `unknown` holds the shared ~/.claude's refresh instead.
 */
export function claudeLivePtyBindingForPersistedEntry(
  entry: ClaudeLivePtyBindingEntry
): ClaudeLivePtyBinding {
  if (entry.route === 'account-dir') {
    return entry.accountId
      ? { route: 'account-dir', accountId: entry.accountId }
      : UNKNOWN_CLAUDE_LIVE_PTY_BINDING
  }
  if (entry.route === 'wsl-dir') {
    return { route: 'wsl-dir', accountId: entry.accountId ?? null }
  }
  return { route: 'shared-dir' }
}

export type ClaudeLivePtyPersistence = {
  addClaudeLivePtySessionId(sessionId: string): void
  removeClaudeLivePtySessionId(sessionId: string): void
  /** Records the account a daemon-surviving session is pinned to. Optional so a
   *  store that predates per-account pinning still satisfies the contract. */
  recordClaudeLivePtyBinding?(sessionId: string, binding: ClaudeLivePtyBinding): void
}

let persistence: ClaudeLivePtyPersistence | null = null

export function attachClaudeLivePtyPersistence(target: ClaudeLivePtyPersistence | null): void {
  persistence = target
}

// Why: a live claude defers the managed OAuth refresh ("Waiting for Claude
// session"); consumers need the 1 -> 0 transition to recover promptly instead
// of waiting out the usage-fetch failure backoff.
type LiveClaudePtyDrainListener = () => void
const drainListeners = new Set<LiveClaudePtyDrainListener>()

export function onLiveClaudePtysDrained(listener: LiveClaudePtyDrainListener): () => void {
  drainListeners.add(listener)
  return () => drainListeners.delete(listener)
}

function notifyDrainedOnTransition(hadLivePtys: boolean): void {
  if (!hadLivePtys || liveClaudePtyIds.size > 0) {
    return
  }
  for (const listener of drainListeners) {
    listener()
  }
}

export function seedLiveClaudePtysFromPersistence(
  sessionIds: readonly string[],
  bindings: Readonly<Record<string, ClaudeLivePtyBinding>> = {}
): void {
  for (const sessionId of sessionIds) {
    liveClaudePtyIds.add(sessionId)
    seededUnconfirmedPtyIds.add(sessionId)
    // Why: a restored session with no recorded binding stays `unknown` rather
    // than defaulting to the currently selected account — attributing it to the
    // wrong account would defer that account's refresh and, worse, leave the
    // surface it really holds unprotected.
    bindingByGateId.set(sessionId, bindings[sessionId] ?? UNKNOWN_CLAUDE_LIVE_PTY_BINDING)
  }
}

export function hasSeededUnconfirmedClaudePtys(): boolean {
  return seededUnconfirmedPtyIds.size > 0
}

/**
 * The ids still awaiting daemon confirmation, snapshotted before the reconcile
 * clears them. Startup needs the list to know WHICH surviving sessions were
 * restored rather than spawned by this process, since only those can be
 * holding the gate for a Claude that is no longer there.
 */
export function getSeededClaudeLivePtyIds(): string[] {
  return [...seededUnconfirmedPtyIds]
}

/** Whether this gate id currently holds the gate closed, under any binding. */
export function isClaudeLivePtyGateHeld(ptyId: string): boolean {
  return liveClaudePtyIds.has(ptyId)
}

/**
 * Reconcile seeded ids against the daemon's live session list. Seeded ids the
 * daemon no longer knows are dead — release them so they cannot defer OAuth
 * refresh forever. Seeded ids that are still alive stay in the gate even if
 * their pane never reattaches: that daemon process still owns the credentials.
 */
export function confirmSeededClaudeLivePtys(aliveSessionIds: readonly string[]): void {
  const hadLivePtys = liveClaudePtyIds.size > 0
  const alive = new Set(aliveSessionIds)
  for (const sessionId of seededUnconfirmedPtyIds) {
    if (!alive.has(sessionId)) {
      liveClaudePtyIds.delete(sessionId)
      bindingByGateId.delete(sessionId)
      persistence?.removeClaudeLivePtySessionId(sessionId)
    }
  }
  seededUnconfirmedPtyIds.clear()
  notifyDrainedOnTransition(hadLivePtys)
}

/**
 * The account a launch pinned itself to is fixed for the life of that session:
 * the CLI reads its credentials out of the config dir it was handed at exec
 * time, and nothing Orca does later can move a running process to another one.
 * Re-binding a live id would therefore describe a session that does not exist.
 */
export function markClaudePtySpawned(
  ptyId: string,
  binding: ClaudeLivePtyBinding = UNKNOWN_CLAUDE_LIVE_PTY_BINDING
): void {
  liveClaudePtyIds.add(ptyId)
  seededUnconfirmedPtyIds.delete(ptyId)
  const effective = bindGateId(ptyId, binding)
  persistence?.addClaudeLivePtySessionId(ptyId)
  persistence?.recordClaudeLivePtyBinding?.(ptyId, effective)
}

/**
 * Fixes a gate id's surface on first attribution.
 *
 * The only entry a later call may still write is one that was never
 * attributed — a restored session whose recorded binding was missing until the
 * daemon handed it back. Anything else is a live process whose config dir was
 * decided at exec time.
 */
function bindGateId(gateId: string, binding: ClaudeLivePtyBinding): ClaudeLivePtyBinding {
  const existing = bindingByGateId.get(gateId)
  if (existing && existing.route !== 'unknown') {
    return existing
  }
  bindingByGateId.set(gateId, binding)
  return binding
}

export function markClaudePtyExited(ptyId: string): void {
  const hadLivePtys = liveClaudePtyIds.size > 0
  liveClaudePtyIds.delete(ptyId)
  seededUnconfirmedPtyIds.delete(ptyId)
  bindingByGateId.delete(ptyId)
  persistence?.removeClaudeLivePtySessionId(ptyId)
  notifyDrainedOnTransition(hadLivePtys)
}

/**
 * Register a structured Claude child with the same gate the terminal path uses.
 *
 * The gate is what makes the managed OAuth refresh defer instead of rotating a
 * single-use refresh token out from under a running Claude (runtime-auth-sync.ts).
 * A structured session's child is as much a live Claude as a PTY's is, so it has to
 * hold the gate too — otherwise a refresh mid-turn breaks its next API call while an
 * identical terminal session is protected.
 *
 * Deliberately not persisted, unlike markClaudePtySpawned: these children are direct
 * children of this process and cannot survive a restart, so seeding them back on the
 * next launch would hold the gate closed for a process that is provably gone.
 */
export function markClaudeStructuredChildSpawned(
  childKey: string,
  binding: ClaudeLivePtyBinding = UNKNOWN_CLAUDE_LIVE_PTY_BINDING
): void {
  liveClaudePtyIds.add(structuredChildGateId(childKey))
  bindGateId(structuredChildGateId(childKey), binding)
}

export function markClaudeStructuredChildExited(childKey: string): void {
  const hadLivePtys = liveClaudePtyIds.size > 0
  liveClaudePtyIds.delete(structuredChildGateId(childKey))
  bindingByGateId.delete(structuredChildGateId(childKey))
  notifyDrainedOnTransition(hadLivePtys)
}

// Namespaced so a structured child can never collide with a daemon PTY session id,
// which confirmSeededClaudeLivePtys reconciles against the daemon's own list.
function structuredChildGateId(childKey: string): string {
  return `claude-structured:${childKey}`
}

export function hasLiveClaudePtys(): boolean {
  return liveClaudePtyIds.size > 0
}

/**
 * Whether a live Claude holds THIS account's credentials, and so owns its
 * single-use refresh token until it exits.
 *
 * An unknown binding deliberately does not count: it cannot be shown to hold
 * this account, and counting it would restore the global block that made one
 * legacy pane freeze every account's refresh.
 */
export function hasLiveClaudePtysForAccount(accountId: string): boolean {
  for (const gateId of liveClaudePtyIds) {
    const binding = bindingByGateId.get(gateId)
    if (
      (binding?.route === 'account-dir' || binding?.route === 'wsl-dir') &&
      binding.accountId === accountId
    ) {
      return true
    }
  }
  return false
}

/**
 * Whether a live Claude may still be reading the user's own ~/.claude.
 *
 * Unknown bindings count here, and only here: a session we cannot attribute is
 * exactly the one that might have been launched against the shared surface
 * before per-account pinning existed, so the shared credentials stay frozen
 * until it drains.
 */
export function hasLiveClaudeSessionsOnSharedSurface(): boolean {
  for (const gateId of liveClaudePtyIds) {
    const route = bindingByGateId.get(gateId)?.route ?? 'unknown'
    if (route === 'shared-dir' || route === 'unknown') {
      return true
    }
  }
  return false
}

export function beginClaudeAuthSwitch(): void {
  if (switchInProgress) {
    throw new Error('A Claude account switch is already in progress.')
  }
  switchInProgress = true
}

export function endClaudeAuthSwitch(): void {
  const wasInProgress = switchInProgress
  switchInProgress = false
  if (!wasInProgress) {
    return
  }
  // Each listener removes itself as it settles; Set iteration is defined over that.
  for (const listener of switchSettledListeners) {
    listener()
  }
}

/**
 * Resolves `true` once no account switch is running, `false` if one is still running
 * at the deadline.
 *
 * Exists for callers that have already done irreversible work — a structured acquire
 * has closed the old child by the time it resolves its launch, so turning a switch
 * into a refusal there strands the user with a dead session and no replacement.
 * Waiting for the swap and then launching against it is the recoverable answer;
 * refusing is only correct when nothing has been torn down yet.
 */
export function whenClaudeAuthSwitchSettles(
  timeoutMs = CLAUDE_AUTH_SWITCH_SETTLE_TIMEOUT_MS
): Promise<boolean> {
  if (!switchInProgress) {
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolve) => {
    const settle = (settled: boolean): void => {
      switchSettledListeners.delete(listener)
      clearTimeout(timer)
      resolve(settled)
    }
    const listener = (): void => settle(true)
    switchSettledListeners.add(listener)
    const timer = setTimeout(() => settle(false), timeoutMs)
    timer.unref?.()
  })
}

export function isClaudeAuthSwitchInProgress(): boolean {
  return switchInProgress
}
