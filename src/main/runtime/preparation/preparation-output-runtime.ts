import { join } from 'node:path'
import { PreparationOutputAttribution } from './preparation-output-attribution'
import {
  PREPARATION_OUTPUT_CAPTURE_LIMIT_BYTES,
  type PreparationArchiveCommit,
  type PreparationOutputChunk,
  type PreparationOutputFilesystem
} from './preparation-output-contracts'
import { PreparationOutputStore } from './preparation-output-store'
import type { PreparationRecordEvent, PreparationRecordStore } from './preparation-record-store'
import type { PreparationLifecyclePane } from './preparation-lifecycle-file'
import { PreparationLifecycleStore } from './preparation-lifecycle-store'
import {
  purgeDeletedPreparationGeneration,
  purgeDeletedPreparationGenerations,
  reconcilePreparationRecord,
  type PreparationPaneInspection,
  type PreparationRecoveryDecision
} from './preparation-recovery'

type Storage = {
  lifecycle: PreparationLifecycleStore
  store: PreparationOutputStore
}

type GenerationPurger = (generation: { host: string; instanceId: string }) => { purged: boolean }

let generationPurger: GenerationPurger | null = null

/**
 * Purges one deleted worktree generation's archives through the configured runtime.
 * Without configured storage there is nothing this process could have archived.
 */
export function purgeDeletedWorktreePreparationGeneration(generation: {
  host: string
  instanceId: string
}): { purged: boolean } {
  return generationPurger?.(generation) ?? { purged: true }
}

/**
 * Per-runtime owner of preparation archives and durable lifecycle facts. Output
 * attribution lives in PreparationOutputAttribution; this class persists what it captured.
 */
export class PreparationOutputRuntime {
  private readonly attribution: PreparationOutputAttribution
  private storage: Storage | null = null
  private readonly purger: GenerationPurger = (generation) => this.purgeGeneration(generation)

  constructor(options: { records: PreparationRecordStore; limitBytes?: number }) {
    this.attribution = new PreparationOutputAttribution({
      records: options.records,
      limitBytes: options.limitBytes ?? PREPARATION_OUTPUT_CAPTURE_LIMIT_BYTES
    })
    // Why from construction: early bytes must be adopted at bind even before storage opens.
    options.records.onChange((event) => this.onRecordEvent(event))
  }

  /**
   * Opens private profile storage, reconciles durable facts that need no liveness (stale temps,
   * outstanding deletion obligations) and arms reattachment for recorded panes. Must run before
   * PTY replay so restored output reaches the right capture.
   */
  configureStorage(options: {
    directory: string
    filesystem?: PreparationOutputFilesystem
    now?: () => number
  }): void {
    this.close()
    const lifecycle = new PreparationLifecycleStore({
      filePath: join(options.directory, 'lifecycle.json'),
      filesystem: options.filesystem,
      now: options.now
    })
    const store = new PreparationOutputStore({
      root: join(options.directory, 'archives'),
      filesystem: options.filesystem,
      now: options.now,
      isGenerationRevoked: (host, instanceId) => lifecycle.isGenerationRevoked(host, instanceId)
    })
    this.storage = { lifecycle, store }
    generationPurger = this.purger
    store.removeStaleTemporaryFiles()
    purgeDeletedPreparationGenerations({
      lifecycle,
      store,
      generations: lifecycle.deletionObligations()
    })
    for (const record of lifecycle.list()) {
      if (
        record.preparation &&
        (record.state === 'observing' || record.state === 'retiring') &&
        !lifecycle.isGenerationRevoked(record.host, record.instanceId)
      ) {
        this.attribution.holdForReattach(record.preparation.ptyId, record.preparationId)
      }
    }
  }

  outputStore(): PreparationOutputStore | null {
    return this.storage?.store ?? null
  }

  lifecycle(): PreparationLifecycleStore | null {
    return this.storage?.lifecycle ?? null
  }

  observe(ptyId: string, chunk: PreparationOutputChunk): void {
    this.attribution.observe(ptyId, chunk)
  }

  /** A live incarnation announced for a recorded pane after restart settles its reattachment. */
  confirmIncarnation(ptyId: string, incarnationId: string | undefined): void {
    if (incarnationId === undefined) {
      return
    }
    const pending = this.attribution.takeReattach(ptyId)
    const storage = this.storage
    const record = pending && storage?.lifecycle.get(pending.preparationId)
    if (!pending || !storage || !record) {
      return
    }
    try {
      const decision = reconcilePreparationRecord(storage.lifecycle, storage.store, record, () => ({
        status: 'live',
        incarnationId
      }))
      if (decision.action === 'reattach') {
        pending.resume(decision.capture)
      }
    } catch (error) {
      console.error('[preparation] restart reconciliation failed:', error)
    }
  }

  /**
   * Restart reconciliation once provider inventory is available: every recorded pane that no
   * live incarnation re-announced is compared with what its execution host reports now. An
   * unverifiable answer changes nothing and keeps the pane awaiting its exact re-announcement.
   */
  async recover(
    inspect: (pane: PreparationLifecyclePane) => Promise<PreparationPaneInspection>
  ): Promise<PreparationRecoveryDecision[]> {
    const storage = this.storage
    if (!storage) {
      return []
    }
    const decisions: PreparationRecoveryDecision[] = []
    for (const record of storage.lifecycle.list()) {
      const pane = record.preparation
      if (!pane || !this.attribution.awaitsReattach(pane.ptyId)) {
        continue
      }
      const closing = record.state === 'retiring' ? record.pendingClose : null
      const observed = await inspect(closing ?? pane)
      if (observed.status === 'unverifiable') {
        decisions.push({
          preparationId: record.preparationId,
          action: 'retain',
          reason: 'unverifiable'
        })
        continue
      }
      if (this.storage !== storage) {
        break
      }
      // Re-read after the await: a re-announcement may have settled this pane meanwhile.
      const pending = this.attribution.takeReattach(pane.ptyId)
      const current = storage.lifecycle.get(record.preparationId)
      if (!pending || !current) {
        continue
      }
      try {
        const decision = reconcilePreparationRecord(
          storage.lifecycle,
          storage.store,
          current,
          () => observed
        )
        if (decision.action === 'reattach') {
          pending.resume(decision.capture)
        }
        decisions.push(decision)
      } catch (error) {
        console.error('[preparation] restart reconciliation failed:', error)
      }
    }
    return decisions
  }

  forgetPty(ptyId: string): void {
    this.attribution.forget(ptyId)
  }

  commit(args: { preparationId: string; inputRevision: number }): PreparationArchiveCommit {
    const storage = this.storage
    if (!storage) {
      return { committed: false, reason: 'storage-failed' }
    }
    const record = storage.lifecycle.get(args.preparationId)
    const pane = record?.preparation
    if (!record || !pane) {
      return { committed: false, reason: 'untracked' }
    }
    const active = this.attribution.capture(pane.ptyId)
    if (!active || active.preparationId !== args.preparationId) {
      return {
        committed: false,
        reason: record.capture === 'complete' ? 'missing-beginning' : record.capture
      }
    }
    const snapshot = active.capture.snapshot()
    try {
      if (!snapshot.authoritative) {
        storage.lifecycle.recordCaptureIncomplete(args.preparationId, snapshot.reason)
        return { committed: false, reason: snapshot.reason }
      }
      const committed = storage.store.commit({
        identity: {
          preparationId: record.preparationId,
          host: record.host,
          worktreeKey: record.worktreeKey,
          instanceId: record.instanceId,
          incarnationId: pane.incarnationId
        },
        snapshot
      })
      if (committed.committed) {
        storage.lifecycle.recordArchive(args.preparationId, {
          archiveId: committed.archiveId,
          finalSequence: committed.finalSequence,
          inputRevision: args.inputRevision,
          durability: committed.durability
        })
      }
      return committed
    } catch (error) {
      // An archive whose lifecycle reference is not durable stays readable but authorizes nothing.
      console.error('[preparation] archive commit failed:', error)
      return { committed: false, reason: 'storage-failed' }
    }
  }

  mayEnqueueSetup(preparationId: string): boolean {
    return this.storage?.lifecycle.mayEnqueueSetup(preparationId) ?? true
  }

  purgeGeneration(generation: { host: string; instanceId: string }): { purged: boolean } {
    const storage = this.storage
    if (!storage) {
      return { purged: true }
    }
    try {
      return purgeDeletedPreparationGeneration({
        lifecycle: storage.lifecycle,
        store: storage.store,
        generation
      })
    } catch (error) {
      // Recording the obligation failed; the archives stay and restart retries nothing, so say so.
      console.error('[preparation] generation purge failed:', error)
      return { purged: false }
    }
  }

  close(): void {
    this.storage?.store.close()
    this.storage = null
    this.attribution.clearReattach()
    if (generationPurger === this.purger) {
      generationPurger = null
    }
  }

  private onRecordEvent(event: PreparationRecordEvent): void {
    const lifecycle = this.storage?.lifecycle
    const { record } = event
    if (event.kind === 'registered') {
      lifecycle?.track({
        preparationId: record.preparationId,
        host: record.worktree.executionHostId,
        worktreeKey: record.worktree.key,
        instanceId: record.worktree.instanceId
      })
      return
    }
    const binding = record[event.role]
    if (!binding) {
      return
    }
    // Legacy providers without an incarnation get no durable pane, so they can never authorize closure.
    if (binding.incarnationId) {
      lifecycle?.bindPane(record.preparationId, event.role, {
        ptyId: binding.ptyId,
        incarnationId: binding.incarnationId
      })
    }
    if (event.role === 'preparation') {
      this.attribution.adopt(binding.ptyId, record.preparationId)
    }
    this.attribution.dropEarlyIfIdle()
  }
}
