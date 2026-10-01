import type { PreparationRecord } from '../../../shared/preparation-contracts'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  retainPty,
  type PtyIdleRetirementRequest,
  type PtyIdleRetirementResult
} from '../../../shared/pty-idle-retirement'
import type { PreparationArchiveCommit } from './preparation-output-contracts'
import type { PreparationLifecycleStore } from './preparation-lifecycle-store'
import {
  PREPARATION_OUTPUT_QUIESCENCE_MS,
  createPreparationRetirement,
  type PreparationLeafFacts,
  type PreparationRetiredLeaf,
  type PreparationRetirementBlocker,
  type PreparationRetirementVerdict
} from './preparation-retirement'

/** What the managing runtime knows about one live PTY; null once it is gone or disconnected. */
export type PreparationLivePty = {
  incarnationId: string
  tabId: string | null
  paneKey: string | null
  outputSequence: number
}

/** The OrcaRuntimeService surface retirement needs; every fact is read at the moment of use. */
export type PreparationRetirementHost = {
  record: (preparationId: string) => PreparationRecord | null
  /** The registration whose preparation pane is this pty, or null for an ordinary terminal. */
  recordForPty: (ptyId: string) => PreparationRecord | null
  cleanupAuthorized: (preparationId: string) => boolean
  lifecycle: () => PreparationLifecycleStore | null
  commitOutput: (args: { preparationId: string; inputRevision: number }) => PreparationArchiveCommit
  livePty: (ptyId: string) => PreparationLivePty | null
  /** Null when the controller cannot count input for this PTY, which forbids retirement. */
  inputRevision: (ptyId: string) => number | null
  /** Canonical layout placement of the leaf across persisted session and runtime graph. */
  layoutSignature: (ptyId: string, tabId: string, leafId: string) => string
  retireIdle: (ptyId: string, request: PtyIdleRetirementRequest) => Promise<PtyIdleRetirementResult>
  setStopRequested: (ptyId: string, requested: boolean) => void
  removeLeaf: (leaf: PreparationRetiredLeaf) => Promise<boolean>
}

export type PreparationRetirementClock = {
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Schedules a re-evaluation after output settles; returns a cancel function. */
  defer: (ms: number, run: () => void) => () => void
}

const realClock: PreparationRetirementClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  defer: (ms, run) => {
    const timer = setTimeout(run, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  }
}

/**
 * Blockers a later fact change can clear; every other verdict is final for this process.
 * `close-pending` clears when the exact incarnation being closed exits (see `noteExit`).
 */
const PENDING_BLOCKERS: ReadonlySet<PreparationRetirementBlocker> = new Set([
  'handoff-unproven',
  'binding-incomplete',
  'output-unsettled',
  'close-pending',
  'evaluation-failed'
])

/**
 * Verdicts that are often transient — a host `ps` capture over its wait budget, or a session
 * write after a confirmed stop — and are retried once output stays quiet. After this many
 * evaluations ending in one of them the verdict is final. `leaf-removal-failed` retries only the
 * idempotent removal of a tombstoned leaf, never a stop.
 */
export const PREPARATION_BOUNDED_RETRY_ATTEMPTS = 3
const BOUNDED_RETRY_BLOCKERS: ReadonlySet<PreparationRetirementBlocker> = new Set([
  'provider:unverifiable',
  'leaf-removal-failed'
])

/**
 * Drives compare-and-retire from runtime events. Evaluations start when observation, binding,
 * archive or exit facts change, never from a title, a timer alone or renderer exit; a final
 * verdict is never re-attempted, so duplicate completion or cleanup events retire at most once.
 */
export class PreparationRetirementRuntime {
  private readonly lastOutputAtByPty = new Map<string, number>()
  private readonly layoutByPty = new Map<string, { signature: string; revision: number }>()
  private readonly finalVerdicts = new Map<string, PreparationRetirementVerdict>()
  private readonly retries = new Map<string, () => void>()
  private readonly boundedAttempts = new Map<string, number>()
  private readonly countedVerdicts = new WeakSet<PreparationRetirementVerdict>()
  private readonly retirement: ReturnType<typeof createPreparationRetirement>

  constructor(
    private readonly host: PreparationRetirementHost,
    private readonly clock: PreparationRetirementClock = realClock
  ) {
    this.retirement = createPreparationRetirement({
      now: clock.now,
      sleep: clock.sleep,
      record: (preparationId) => this.record(preparationId),
      cleanupAuthorized: host.cleanupAuthorized,
      lifecycle: host.lifecycle,
      commitOutput: host.commitOutput,
      leafFacts: (ptyId) => this.leafFacts(ptyId),
      retireIdle: (ptyId, request) => this.retireIdle(ptyId, request),
      removeLeaf: host.removeLeaf
    })
  }

  noteOutput(ptyId: string): void {
    const record = this.host.recordForPty(ptyId)
    if (!record) {
      return
    }
    this.lastOutputAtByPty.set(ptyId, this.clock.now())
    const retry = this.retries.get(record.preparationId)
    if (retry) {
      // Output that outlasted the settlement window gets a fresh window once it quiesces.
      retry()
      this.armRetry(record.preparationId)
    }
  }

  forgetPty(ptyId: string): void {
    this.lastOutputAtByPty.delete(ptyId)
    this.layoutByPty.delete(ptyId)
  }

  /**
   * The preparation pane's incarnation exited. When it is the exact incarnation a close is still
   * pending on (an unconfirmed stop, or a tombstone that could not be persisted), the stop is now
   * a fact: tombstone it and finish the leaf removal. Any other exit changes nothing here.
   */
  noteExit(ptyId: string, incarnationId: string | undefined): void {
    const record = this.host.recordForPty(ptyId)
    const lifecycle = this.host.lifecycle()
    const state = record && lifecycle ? lifecycle.get(record.preparationId) : null
    const pending = state?.state === 'retiring' ? state.pendingClose : null
    if (
      !record ||
      !lifecycle ||
      !pending ||
      incarnationId === undefined ||
      pending.ptyId !== ptyId ||
      pending.incarnationId !== incarnationId
    ) {
      return
    }
    try {
      lifecycle.reconcile(record.preparationId, { kind: 'retired' })
    } catch (error) {
      // Still durably retiring on this incarnation: restart recovery reconciles the exit.
      console.error('[preparation] exit of a closing preparation could not be recorded:', error)
      return
    }
    this.factsChanged(record.preparationId)
  }

  /** A runner outcome, takeover receipt, binding, archive or exit fact changed for this preparation. */
  factsChanged(preparationId: string): void {
    if (!this.record(preparationId) || this.finalVerdicts.has(preparationId)) {
      return
    }
    // A tombstoned preparation only finishes its leaf removal, which needs no takeover proof.
    const tombstoned = this.host.lifecycle()?.get(preparationId)?.state === 'retired'
    if (!tombstoned && !this.host.cleanupAuthorized(preparationId)) {
      return
    }
    void this.evaluate(preparationId)
  }

  async evaluate(preparationId: string): Promise<PreparationRetirementVerdict> {
    const final = this.finalVerdicts.get(preparationId)
    if (final) {
      return final
    }
    let verdict: PreparationRetirementVerdict
    try {
      verdict = await this.retirement.evaluate(preparationId)
    } catch (error) {
      // Never an unhandled rejection from a fact-driven evaluation, and never a final verdict.
      console.error('[preparation] retirement evaluation failed:', error)
      return { outcome: 'retained', blockers: ['evaluation-failed'] }
    }
    const blockers = verdict.outcome === 'retained' ? verdict.blockers : []
    if (this.takeBoundedRetry(preparationId, verdict, blockers)) {
      this.armRetry(preparationId)
      return verdict
    }
    const pending =
      verdict.outcome === 'unconfirmed' ||
      (blockers.length > 0 && blockers.every((blocker) => PENDING_BLOCKERS.has(blocker)))
    if (!pending) {
      this.finalVerdicts.set(preparationId, verdict)
      this.retries.get(preparationId)?.()
      this.retries.delete(preparationId)
    } else if (blockers.includes('output-unsettled')) {
      this.armRetry(preparationId)
    }
    return verdict
  }

  /**
   * True while a transient verdict still has attempts left. Concurrent callers share one run and
   * its verdict object, so each run consumes one attempt however many callers awaited it.
   */
  private takeBoundedRetry(
    preparationId: string,
    verdict: PreparationRetirementVerdict,
    blockers: PreparationRetirementBlocker[]
  ): boolean {
    if (blockers.length !== 1 || !BOUNDED_RETRY_BLOCKERS.has(blockers[0])) {
      return false
    }
    let attempts = this.boundedAttempts.get(preparationId) ?? 0
    if (!this.countedVerdicts.has(verdict)) {
      this.countedVerdicts.add(verdict)
      attempts += 1
      this.boundedAttempts.set(preparationId, attempts)
    }
    return attempts < PREPARATION_BOUNDED_RETRY_ATTEMPTS
  }

  private armRetry(preparationId: string): void {
    this.retries.get(preparationId)?.()
    const cancel = this.clock.defer(PREPARATION_OUTPUT_QUIESCENCE_MS, () => {
      if (this.retries.get(preparationId) === cancel) {
        this.retries.delete(preparationId)
        this.factsChanged(preparationId)
      }
    })
    this.retries.set(preparationId, cancel)
  }
  private record(preparationId: string): PreparationRecord | null {
    return this.host.record(preparationId)
  }

  private recordForPreparationPty(ptyId: string): PreparationRecord | null {
    return this.host.recordForPty(ptyId)
  }
  private leafFacts(ptyId: string): PreparationLeafFacts | null {
    const pty = this.host.livePty(ptyId)
    const binding = this.recordForPreparationPty(ptyId)?.preparation
    const inputRevision = this.host.inputRevision(ptyId)
    if (!pty || !binding?.tabId || !binding.leafId || inputRevision === null) {
      return null
    }
    // The runtime's own record of where this PTY lives; a moved pane is a different leaf.
    const pane = pty.paneKey ? parsePaneKey(pty.paneKey) : null
    const tabId = pane?.tabId ?? pty.tabId ?? binding.tabId
    const leafId = pane?.leafId ?? binding.leafId
    const signature = this.host.layoutSignature(ptyId, tabId, leafId)
    const layout = this.layoutByPty.get(ptyId)
    const revision =
      layout === undefined
        ? 0
        : layout.signature === signature
          ? layout.revision
          : layout.revision + 1
    this.layoutByPty.set(ptyId, { signature, revision })
    return {
      incarnationId: pty.incarnationId,
      tabId,
      leafId,
      inputRevision,
      layoutRevision: revision,
      outputSequence: pty.outputSequence,
      lastOutputAt: this.lastOutputAtByPty.get(ptyId) ?? 0
    }
  }

  private async retireIdle(
    ptyId: string,
    request: PtyIdleRetirementRequest
  ): Promise<PtyIdleRetirementResult> {
    // Why: marked first so the exit this stop causes reads as an operator close, not a crash.
    this.host.setStopRequested(ptyId, true)
    let result: PtyIdleRetirementResult
    try {
      result = await this.host.retireIdle(ptyId, request)
    } catch (error) {
      console.error('[preparation] retireIdle failed:', error)
      result = { outcome: 'unconfirmed' }
    }
    if (result.outcome === 'retained') {
      this.host.setStopRequested(ptyId, false)
    }
    return result
  }
}

/** Controller without the exact-enforcement seam: unsupported, never an ordinary stop. */
export function retainUnsupportedRetirement(): Promise<PtyIdleRetirementResult> {
  return Promise.resolve(retainPty('unsupported'))
}
