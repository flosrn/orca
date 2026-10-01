import * as nodeFs from 'node:fs'
import type {
  PreparationOutputFilesystem,
  PreparationOutputIncompleteness
} from './preparation-output-contracts'
import {
  generationRevoked,
  listDeletionObligations,
  markGenerationDeleted,
  markGenerationPurged
} from './preparation-deletion-obligations'
import {
  type LifecycleReconcileOutcome,
  PreparationLifecycleError,
  cloneFile,
  cloneRecord,
  closureArchiveOf,
  newLifecycleRecord,
  readLifecycleFile,
  writeLifecycleFile,
  type LifecycleFile,
  type PreparationDeletionObligation,
  type PreparationLifecycleArchive,
  type PreparationLifecyclePane,
  type PreparationLifecycleRecord,
  type PreparationRetentionReason
} from './preparation-lifecycle-file'

/**
 * Durable preparation lifecycle facts. Every mutation is persisted by temp write, fsync,
 * rename and directory fsync before it returns; a persistence failure throws, so no caller acts
 * on a fact that is not durable. Recovery reconciles only these recorded identities.
 */
export class PreparationLifecycleStore {
  private readonly filePath: string
  private readonly fs: PreparationOutputFilesystem
  private readonly now: () => number
  private state: LifecycleFile
  private readonly byId = new Map<string, PreparationLifecycleRecord>()

  constructor(options: {
    filePath: string
    filesystem?: PreparationOutputFilesystem
    now?: () => number
  }) {
    this.filePath = options.filePath
    this.fs = options.filesystem ?? nodeFs
    this.now = options.now ?? Date.now
    this.state = this.load()
    this.reindex()
  }

  list(): PreparationLifecycleRecord[] {
    return this.state.records.map(cloneRecord)
  }

  get(preparationId: string): PreparationLifecycleRecord | null {
    const record = this.byId.get(preparationId)
    return record ? cloneRecord(record) : null
  }

  track(args: {
    preparationId: string
    host: string
    worktreeKey: string
    instanceId: string
  }): void {
    const existing = this.byId.get(args.preparationId)
    if (existing) {
      if (
        existing.host !== args.host ||
        existing.worktreeKey !== args.worktreeKey ||
        existing.instanceId !== args.instanceId
      ) {
        throw new PreparationLifecycleError('preparation_lifecycle_conflict')
      }
      return
    }
    this.mutate(undefined, () => {
      const record = newLifecycleRecord(args)
      this.state.records.push(record)
      this.byId.set(record.preparationId, record)
    })
  }

  /** First acknowledged incarnation wins; the same incarnation reattaches, a replacement is refused. */
  bindPane(
    preparationId: string,
    role: 'preparation' | 'agent',
    pane: PreparationLifecyclePane
  ): boolean {
    const record = this.require(preparationId)
    const bound = record[role]
    if (bound) {
      return bound.ptyId === pane.ptyId && bound.incarnationId === pane.incarnationId
    }
    this.mutate(record, () => {
      record[role] = { ptyId: pane.ptyId, incarnationId: pane.incarnationId }
    })
    return true
  }

  /** Capture loss is permanent: no later archive can restore closure authority. */
  recordCaptureIncomplete(preparationId: string, reason: PreparationOutputIncompleteness): void {
    const record = this.require(preparationId)
    if (record.capture !== 'complete' || record.state === 'retired') {
      return
    }
    this.mutate(record, () => {
      record.capture = reason
      record.closureArchiveId = null
      this.retain(record, 'capture-incomplete')
    })
  }

  /**
   * Records a committed archive; it carries closure authority only when complete and durable.
   * An archive fenced on a higher input revision than the previous one proves input arrived after
   * that earlier snapshot, which durably retains the pane like `recordInput`.
   */
  recordArchive(preparationId: string, archive: PreparationLifecycleArchive): void {
    const record = this.require(preparationId)
    if (record.archives.some((entry) => entry.archiveId === archive.archiveId)) {
      return
    }
    const previous = record.archives.at(-1)
    const inputAfterSnapshot =
      previous !== undefined && archive.inputRevision > previous.inputRevision
    this.mutate(record, () => {
      record.archives.push({ ...archive })
      if (inputAfterSnapshot) {
        record.closureArchiveId = null
        this.retain(record, 'input-after-snapshot')
        return
      }
      const authorizes =
        record.state === 'observing' &&
        record.capture === 'complete' &&
        archive.durability === 'established'
      record.closureArchiveId = authorizes ? archive.archiveId : null
    })
  }

  /** Output past the closure snapshot invalidates it; a later snapshot may recapture closure. */
  recordOutput(preparationId: string, sequence: number): void {
    const record = this.require(preparationId)
    const closure = closureArchiveOf(record)
    if (!closure || sequence <= closure.finalSequence) {
      return
    }
    this.mutate(record, () => {
      record.closureArchiveId = null
    })
  }

  /** Input after a snapshot can never be recaptured into closure permission. */
  recordInput(preparationId: string, inputRevision: number): void {
    const record = this.require(preparationId)
    const latest = record.archives.at(-1)
    if (!latest || inputRevision <= latest.inputRevision || record.state === 'retired') {
      return
    }
    this.mutate(record, () => {
      record.closureArchiveId = null
      this.retain(record, 'input-after-snapshot')
    })
  }

  closureArchive(preparationId: string): PreparationLifecycleArchive | null {
    const record = this.byId.get(preparationId)
    if (!record || record.state !== 'observing') {
      return null
    }
    const closure = closureArchiveOf(record)
    return closure ? { ...closure } : null
  }

  /** Persists the exact incarnation being closed before any stop is issued. */
  beginClose(preparationId: string, archiveId: string): boolean {
    const record = this.require(preparationId)
    const pane = record.preparation
    if (record.state !== 'observing' || record.closureArchiveId !== archiveId || !pane) {
      return false
    }
    this.mutate(record, () => {
      record.state = 'retiring'
      record.pendingClose = { ...pane, archiveId }
    })
    return true
  }

  /**
   * `stopped` tombstones the preparation. `failed` returns it to observing with its archive and
   * any still-valid closure snapshot. `ambiguous` keeps it retiring so recovery reconciles the
   * exact old incarnation before anything settles.
   */
  settleClose(preparationId: string, outcome: 'stopped' | 'failed' | 'ambiguous'): void {
    const record = this.require(preparationId)
    if (record.state !== 'retiring' || outcome === 'ambiguous') {
      return
    }
    this.mutate(record, () => {
      record.pendingClose = null
      record.state = outcome === 'stopped' ? 'retired' : 'observing'
    })
  }

  /**
   * Setup is enqueued only into a preparation that is not being or has not been closed: a pending
   * close (`retiring`) and a tombstone (`retired`) both refuse, on activation or remount.
   */
  mayEnqueueSetup(preparationId: string): boolean {
    const state = this.byId.get(preparationId)?.state
    return state === undefined || state === 'observing' || state === 'retained'
  }

  isGenerationRevoked(host: string, instanceId: string): boolean {
    return generationRevoked(this.state, host, instanceId)
  }

  deletionObligations(): PreparationDeletionObligation[] {
    return listDeletionObligations(this.state)
  }

  /** Called only after the canonical worktree generation was successfully deleted. */
  recordGenerationDeleted(generation: { host: string; instanceId: string }): void {
    this.mutate(undefined, () => markGenerationDeleted(this.state, generation, this.now()))
  }

  /** Drops the generation's records and obligation once its archives are gone. */
  completeGenerationPurge(generation: { host: string; instanceId: string }): void {
    this.mutate(undefined, () => {
      markGenerationPurged(this.state, generation)
      this.reindex()
    })
  }

  /** Recovery-only: settles a reconciled pending close or retains a record whose proof is gone. */
  reconcile(preparationId: string, outcome: LifecycleReconcileOutcome): void {
    const record = this.require(preparationId)
    this.mutate(record, () => {
      record.pendingClose = null
      if (outcome.kind === 'retired') {
        record.state = 'retired'
        return
      }
      if (outcome.kind === 'observing') {
        record.state = 'observing'
        return
      }
      if (outcome.capture && record.capture === 'complete') {
        record.capture = outcome.capture
      }
      record.closureArchiveId = null
      this.retain(record, outcome.reason)
    })
  }

  private retain(record: PreparationLifecycleRecord, reason: PreparationRetentionReason): void {
    if (record.state === 'retired') {
      return
    }
    record.state = 'retained'
    record.retainedReason = record.retainedReason ?? reason
  }

  private require(preparationId: string): PreparationLifecycleRecord {
    const record = this.byId.get(preparationId)
    if (!record) {
      throw new Error(`Unknown preparation ${preparationId}`)
    }
    return record
  }

  /**
   * Mutates live state and rolls that mutation back when the new file cannot be made durable,
   * so memory never runs ahead of disk. A record argument copies and restores only that record;
   * mutations without one copy the file because they rewrite its arrays.
   */
  private mutate(record: PreparationLifecycleRecord | undefined, change: () => void): void {
    if (!record) {
      const previous = cloneFile(this.state)
      try {
        change()
        this.persist()
      } catch (error) {
        this.state = previous
        this.reindex()
        throw error
      }
      return
    }
    const previous = cloneRecord(record)
    try {
      change()
      this.persist()
    } catch (error) {
      Object.assign(record, previous)
      throw error
    }
  }

  private reindex(): void {
    this.byId.clear()
    for (const record of this.state.records) {
      this.byId.set(record.preparationId, record)
    }
  }

  private load(): LifecycleFile {
    return readLifecycleFile(this.fs, this.filePath)
  }

  private persist(): void {
    writeLifecycleFile(this.fs, this.filePath, this.state)
  }
}
