import { PreparationOutputCapture } from './preparation-output-capture'
import { generationKey, type PreparationOutputStore } from './preparation-output-store'
import type {
  PreparationLifecyclePane,
  PreparationLifecycleRecord,
  PreparationRetentionReason
} from './preparation-lifecycle-file'
import type { PreparationLifecycleStore } from './preparation-lifecycle-store'

export type PreparationPaneInspection =
  | { status: 'live'; incarnationId: string }
  | { status: 'exited' }
  | { status: 'unverifiable' }

export type PreparationRecoveryDecision =
  | {
      preparationId: string
      action: 'reattach'
      pane: PreparationLifecyclePane
      /** Seeded from the committed closure archive; the next chunk must start at its final sequence. */
      capture: PreparationOutputCapture
    }
  | { preparationId: string; action: 'retain'; reason: PreparationRetentionReason | 'unverifiable' }
  | { preparationId: string; action: 'retired' }
/**
 * Restart reconciliation. Never reconstructs ownership from titles or paths, never replays
 * setup, and never imports daemon wake authority: it only compares recorded incarnations with
 * what the execution host reports now.
 */
export function recoverPreparationLifecycle(args: {
  lifecycle: PreparationLifecycleStore
  store: PreparationOutputStore
  inspect: (pane: PreparationLifecyclePane) => PreparationPaneInspection
}): PreparationRecoveryDecision[] {
  const { lifecycle, store, inspect } = args
  store.removeStaleTemporaryFiles()
  purgeDeletedPreparationGenerations({
    lifecycle,
    store,
    generations: lifecycle.deletionObligations()
  })
  const decisions: PreparationRecoveryDecision[] = []
  for (const record of lifecycle.list()) {
    if (lifecycle.isGenerationRevoked(record.host, record.instanceId)) {
      continue
    }
    if (record.state === 'retired') {
      decisions.push({ preparationId: record.preparationId, action: 'retired' })
      continue
    }
    if (record.state === 'retained') {
      decisions.push({
        preparationId: record.preparationId,
        action: 'retain',
        reason: record.retainedReason ?? 'capture-incomplete'
      })
      continue
    }
    decisions.push(reconcilePreparationRecord(lifecycle, store, record, inspect))
  }
  return decisions
}

/**
 * After a successful deletion of the canonical worktree generation: revoke reads, purge that exact
 * host/generation, and keep the obligation while any of its archives survive.
 */
export function purgeDeletedPreparationGeneration(args: {
  lifecycle: PreparationLifecycleStore
  store: PreparationOutputStore
  generation: { host: string; instanceId: string }
}): { purged: boolean } {
  const purged = purgeDeletedPreparationGenerations({
    lifecycle: args.lifecycle,
    store: args.store,
    generations: [args.generation]
  })
  return { purged: purged.length === 1 }
}

/**
 * Batch form of purgeDeletedPreparationGeneration: archive headers are scanned once to attribute
 * every generation and once more to prove none survived, instead of twice per generation.
 * Returns the generations whose obligation was completed.
 */
export function purgeDeletedPreparationGenerations(args: {
  lifecycle: PreparationLifecycleStore
  store: PreparationOutputStore
  generations: readonly { host: string; instanceId: string }[]
}): { host: string; instanceId: string }[] {
  const { lifecycle, store } = args
  if (args.generations.length === 0) {
    return []
  }
  const generations = args.generations.map((entry) => ({
    host: entry.host,
    instanceId: entry.instanceId
  }))
  for (const generation of generations) {
    lifecycle.recordGenerationDeleted(generation)
  }
  const onDisk = store.archiveIdsByGeneration()
  const failedKeys = new Set<string>()
  for (const generation of generations) {
    const key = generationKey(generation)
    if (store.purgeArchives(onDisk.get(key) ?? []).failed.length > 0) {
      failedKeys.add(key)
    }
  }
  const surviving = store.archiveIdsByGeneration()
  const purged: { host: string; instanceId: string }[] = []
  for (const generation of generations) {
    const key = generationKey(generation)
    if (failedKeys.has(key) || surviving.has(key)) {
      continue
    }
    lifecycle.completeGenerationPurge(generation)
    purged.push(generation)
  }
  return purged
}

/** Reconciles one recorded preparation against what the execution host reports for its panes. */
export function reconcilePreparationRecord(
  lifecycle: PreparationLifecycleStore,
  store: PreparationOutputStore,
  record: PreparationLifecycleRecord,
  inspect: (pane: PreparationLifecyclePane) => PreparationPaneInspection
): PreparationRecoveryDecision {
  const { preparationId } = record
  if (record.state === 'retiring' && record.pendingClose) {
    const observed = inspect(record.pendingClose)
    if (observed.status === 'unverifiable') {
      return { preparationId, action: 'retain', reason: 'unverifiable' }
    }
    if (
      observed.status === 'exited' ||
      observed.incarnationId !== record.pendingClose.incarnationId
    ) {
      lifecycle.reconcile(preparationId, { kind: 'retired' })
      return { preparationId, action: 'retired' }
    }
    // The exact old incarnation is still live: the close never applied.
    lifecycle.reconcile(preparationId, { kind: 'observing' })
  }
  const pane = record.preparation
  if (!pane) {
    lifecycle.reconcile(preparationId, { kind: 'retained', reason: 'unbound' })
    return { preparationId, action: 'retain', reason: 'unbound' }
  }
  const observed = inspect(pane)
  if (observed.status === 'unverifiable') {
    return { preparationId, action: 'retain', reason: 'unverifiable' }
  }
  if (observed.status === 'exited') {
    lifecycle.reconcile(preparationId, { kind: 'retained', reason: 'incarnation-exited' })
    return { preparationId, action: 'retain', reason: 'incarnation-exited' }
  }
  if (observed.incarnationId !== pane.incarnationId) {
    lifecycle.reconcile(preparationId, { kind: 'retained', reason: 'ownership-changed' })
    return { preparationId, action: 'retain', reason: 'ownership-changed' }
  }
  const closure = lifecycle.closureArchive(preparationId)
  const text = closure ? readArchiveText(store, closure.archiveId) : null
  if (!closure || text === null) {
    // Pre-crash capture lived only in memory; without a covering archive the beginning is lost.
    lifecycle.reconcile(preparationId, {
      kind: 'retained',
      reason: 'capture-incomplete',
      capture: 'missing-beginning'
    })
    return { preparationId, action: 'retain', reason: 'capture-incomplete' }
  }
  return {
    preparationId,
    action: 'reattach',
    pane: { ...pane },
    capture: PreparationOutputCapture.resume({ text, finalSequence: closure.finalSequence })
  }
}

/** Whole redacted archive text, or null when any page is unavailable. */
export function readArchiveText(store: PreparationOutputStore, archiveId: string): string | null {
  const pages: string[] = []
  let offset: number | null = 0
  try {
    while (offset !== null) {
      const page = store.read({ archiveId, offset })
      pages.push(page.text)
      offset = page.nextOffset
    }
  } catch {
    return null
  }
  return pages.join('')
}
