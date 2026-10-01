import type { PreparationRecord } from '../../../shared/preparation-contracts'
import { PS_TIMEOUT_MS } from '../../../shared/process-table-snapshot-reader'
import type {
  PtyIdleRetirementRequest,
  PtyIdleRetirementResult,
  PtyIdleRetirementRetainReason
} from '../../../shared/pty-idle-retirement'
import type { WorktreeIdentity } from '../../../shared/worktree/identity'
import type { PreparationArchiveCommit } from './preparation-output-contracts'
import type { PreparationLifecycleStore } from './preparation-lifecycle-store'

/** Output quiet time required before a snapshot; never runner-success or agent evidence. */
export const PREPARATION_OUTPUT_QUIESCENCE_MS = 250
/** Whole budget for output to settle across every snapshot attempt. */
export const PREPARATION_SETTLEMENT_WINDOW_MS = 5_000
/** Output-only changes permit this many snapshots beyond the first. */
export const PREPARATION_MAX_RESNAPSHOTS = 3
/**
 * Budget for the provider stop itself, started when the stop is issued, never the settlement
 * leftover: a relay or daemon may spend a whole `ps` capture inside it before the round trip.
 */
export const PREPARATION_PROVIDER_STOP_BUDGET_MS = PS_TIMEOUT_MS + 5_000

/** Live facts the managing runtime holds for one leaf; every mutation moves one of them. */
export type PreparationLeafFacts = {
  incarnationId: string
  tabId: string
  leafId: string
  inputRevision: number
  layoutRevision: number
  outputSequence: number
  lastOutputAt: number
}

export type PreparationRetiredLeaf = {
  preparationId: string
  worktree: WorktreeIdentity
  tabId: string
  leafId: string
  ptyId: string
  incarnationId: string
}

export type PreparationRetirementPorts = {
  now: () => number
  sleep: (ms: number) => Promise<void>
  record: (preparationId: string) => PreparationRecord | null
  cleanupAuthorized: (preparationId: string) => boolean
  lifecycle: () => Pick<
    PreparationLifecycleStore,
    'get' | 'closureArchive' | 'beginClose' | 'settleClose'
  > | null
  commitOutput: (args: { preparationId: string; inputRevision: number }) => PreparationArchiveCommit
  leafFacts: (ptyId: string) => PreparationLeafFacts | null
  retireIdle: (ptyId: string, request: PtyIdleRetirementRequest) => Promise<PtyIdleRetirementResult>
  /** Canonical removal from runtime layout, persistence and renderer consumers; idempotent. */
  removeLeaf: (leaf: PreparationRetiredLeaf) => Promise<boolean>
}

export type PreparationRetirementBlocker =
  | 'unregistered'
  | 'binding-incomplete'
  | 'handoff-unproven'
  | 'capture-incomplete'
  | 'close-pending'
  | 'replaced'
  | 'input-changed'
  | 'layout-changed'
  | 'output-unsettled'
  | 'snapshot-attempts-exhausted'
  | 'archive-uncommitted'
  | 'closure-unauthorized'
  | 'leaf-removal-failed'
  /** The evaluation itself threw; nothing was decided, so a later fact may evaluate again. */
  | 'evaluation-failed'
  | `provider:${PtyIdleRetirementRetainReason}`

export type PreparationRetirementVerdict =
  | { outcome: 'retired' }
  | { outcome: 'unconfirmed' }
  | { outcome: 'retained'; blockers: PreparationRetirementBlocker[] }

type Fence = {
  preparationId: string
  incarnationId: string
  tabId: string
  leafId: string
  inputRevision: number
  layoutRevision: number
}

const retained = (...blockers: PreparationRetirementBlocker[]): PreparationRetirementVerdict => ({
  outcome: 'retained',
  blockers
})

const OUTPUT_ONLY_PROVIDER_REASONS: ReadonlySet<PtyIdleRetirementRetainReason> = new Set([
  'output_advanced',
  'output_during_inspection'
])

/**
 * Compare-and-retire for one preparation leaf. Retirement never blocks competing input,
 * rebind or layout changes: each moves a revision the fence compares after every await, and the
 * provider repeats the input/output fence atomically at the stop. Any changed or missing proof
 * retains the leaf; only a provider-confirmed stop of the exact incarnation removes it.
 */
export function createPreparationRetirement(ports: PreparationRetirementPorts): {
  evaluate: (preparationId: string) => Promise<PreparationRetirementVerdict>
} {
  const inFlight = new Map<string, Promise<PreparationRetirementVerdict>>()

  function refute(
    fence: Fence,
    facts: PreparationLeafFacts | null
  ): PreparationRetirementBlocker | null {
    if (!facts || facts.incarnationId !== fence.incarnationId) {
      return 'replaced'
    }
    if (facts.inputRevision !== fence.inputRevision) {
      return 'input-changed'
    }
    if (
      facts.layoutRevision !== fence.layoutRevision ||
      facts.tabId !== fence.tabId ||
      facts.leafId !== fence.leafId
    ) {
      return 'layout-changed'
    }
    // Takeover proof is a live fact too: agent exit or a new approval request revokes it mid-run.
    if (!ports.cleanupAuthorized(fence.preparationId)) {
      return 'handoff-unproven'
    }
    return null
  }

  async function removeRetired(
    leaf: PreparationRetiredLeaf
  ): Promise<PreparationRetirementVerdict> {
    try {
      return (await ports.removeLeaf(leaf))
        ? { outcome: 'retired' }
        : retained('leaf-removal-failed')
    } catch (error) {
      console.error('[preparation] retired leaf removal failed:', error)
      return retained('leaf-removal-failed')
    }
  }

  /** False when the outcome could not be made durable; the record keeps its prior state. */
  function settle(
    lifecycle: Pick<PreparationLifecycleStore, 'settleClose'>,
    preparationId: string,
    outcome: 'stopped' | 'failed'
  ): boolean {
    try {
      lifecycle.settleClose(preparationId, outcome)
      return true
    } catch (error) {
      console.error(`[preparation] close settlement (${outcome}) is not durable:`, error)
      return false
    }
  }

  async function run(preparationId: string): Promise<PreparationRetirementVerdict> {
    const record = ports.record(preparationId)
    const lifecycle = ports.lifecycle()
    const state = lifecycle?.get(preparationId) ?? null
    const pane = record?.preparation ?? null
    if (!record || !lifecycle || !state) {
      return retained('unregistered')
    }
    if (!pane?.incarnationId || !pane.tabId || !pane.leafId) {
      return retained('binding-incomplete')
    }
    const leaf: PreparationRetiredLeaf = {
      preparationId,
      worktree: record.worktree,
      tabId: pane.tabId,
      leafId: pane.leafId,
      ptyId: pane.ptyId,
      incarnationId: pane.incarnationId
    }
    if (state.state === 'retired') {
      // Tombstoned: never stop again, but finish a removal a crash may have interrupted.
      return removeRetired(leaf)
    }
    if (state.state === 'retiring') {
      return retained('close-pending')
    }
    const blockers: PreparationRetirementBlocker[] = []
    if (
      !state.preparation ||
      state.preparation.ptyId !== pane.ptyId ||
      state.preparation.incarnationId !== pane.incarnationId
    ) {
      blockers.push('binding-incomplete')
    }
    if (!ports.cleanupAuthorized(preparationId)) {
      blockers.push('handoff-unproven')
    }
    if (state.capture !== 'complete' || state.state === 'retained') {
      blockers.push('capture-incomplete')
    }
    const initial = ports.leafFacts(pane.ptyId)
    if (!initial || initial.incarnationId !== pane.incarnationId) {
      blockers.push('replaced')
    } else if (initial.tabId !== pane.tabId || initial.leafId !== pane.leafId) {
      blockers.push('layout-changed')
    }
    if (blockers.length > 0 || !initial) {
      return { outcome: 'retained', blockers }
    }

    const fence: Fence = {
      preparationId,
      incarnationId: initial.incarnationId,
      tabId: initial.tabId,
      leafId: initial.leafId,
      inputRevision: initial.inputRevision,
      layoutRevision: initial.layoutRevision
    }
    const deadline = ports.now() + PREPARATION_SETTLEMENT_WINDOW_MS
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > PREPARATION_MAX_RESNAPSHOTS) {
        return retained('snapshot-attempts-exhausted')
      }
      // Quiescence: the snapshot must end after 250 ms without provider output.
      for (;;) {
        const facts = ports.leafFacts(pane.ptyId)
        const changed = refute(fence, facts)
        if (changed) {
          return retained(changed)
        }
        const quietFor = ports.now() - (facts?.lastOutputAt ?? 0)
        if (quietFor >= PREPARATION_OUTPUT_QUIESCENCE_MS) {
          break
        }
        const wait = PREPARATION_OUTPUT_QUIESCENCE_MS - quietFor
        if (ports.now() + wait > deadline) {
          return retained('output-unsettled')
        }
        await ports.sleep(wait)
      }

      const commit = ports.commitOutput({ preparationId, inputRevision: fence.inputRevision })
      if (!commit.committed || commit.durability !== 'established') {
        return retained('archive-uncommitted')
      }
      const afterCommit = refute(fence, ports.leafFacts(pane.ptyId))
      if (afterCommit) {
        return retained(afterCommit)
      }
      const closure = lifecycle.closureArchive(preparationId)
      if (closure?.archiveId !== commit.archiveId) {
        if (lifecycle.get(preparationId)?.state !== 'observing') {
          return retained('closure-unauthorized')
        }
        // Output landed after the snapshot and invalidated it: take a superseding one.
        continue
      }
      // Last fence before the durable close: every await above may have revoked a proof.
      const beforeClose = refute(fence, ports.leafFacts(pane.ptyId))
      if (beforeClose) {
        return retained(beforeClose)
      }
      let closing: boolean
      try {
        closing = lifecycle.beginClose(preparationId, commit.archiveId)
      } catch (error) {
        // The close was never made durable, so no stop may be issued against it.
        console.error('[preparation] close could not be recorded:', error)
        closing = false
      }
      if (!closing) {
        return retained('closure-unauthorized')
      }

      let result: PtyIdleRetirementResult
      try {
        result = await ports.retireIdle(pane.ptyId, {
          expectedIncarnationId: fence.incarnationId,
          expectedOutputChars: closure.finalSequence,
          deadlineMs: ports.now() + PREPARATION_PROVIDER_STOP_BUDGET_MS
        })
      } catch (error) {
        console.error('[preparation] provider retirement failed:', error)
        result = { outcome: 'unconfirmed' }
      }
      if (result.outcome === 'stopped' || result.outcome === 'exited') {
        // The stop is a fact even when its tombstone is not durable: remove the dead leaf anyway.
        // The record stays retiring on this exact incarnation, so its exit or restart recovery
        // reconciles it to retired.
        settle(lifecycle, preparationId, 'stopped')
        return removeRetired(leaf)
      }
      if (result.outcome === 'unconfirmed') {
        // The stop may have applied; recovery reconciles the exact old incarnation.
        lifecycle.settleClose(preparationId, 'ambiguous')
        return { outcome: 'unconfirmed' }
      }
      if (!settle(lifecycle, preparationId, 'failed')) {
        return retained('close-pending')
      }
      if (!OUTPUT_ONLY_PROVIDER_REASONS.has(result.reason)) {
        return retained(`provider:${result.reason}`)
      }
    }
  }

  return {
    evaluate(preparationId) {
      const pending = inFlight.get(preparationId)
      if (pending) {
        return pending
      }
      const started = run(preparationId).finally(() => inFlight.delete(preparationId))
      inFlight.set(preparationId, started)
      return started
    }
  }
}
