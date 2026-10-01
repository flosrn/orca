import * as nodeFs from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PreparationOutputCapture } from './preparation-output-capture'
import type { PreparationOutputFilesystem } from './preparation-output-contracts'
import { PreparationOutputStore } from './preparation-output-store'
import { PreparationLifecycleStore } from './preparation-lifecycle-store'
import {
  purgeDeletedPreparationGeneration,
  recoverPreparationLifecycle,
  type PreparationPaneInspection
} from './preparation-recovery'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const GENERATION = { host: 'localhost', instanceId: 'instance-1' }
const WORKTREE_KEY = 'wt2:localhost:instance-1'
const PANE = { ptyId: 'pty-prep', incarnationId: 'inc-1' }

function workspace(): { lifecycleFile: string; archiveRoot: string } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-preparation-recovery-'))
  directories.push(directory)
  return {
    lifecycleFile: join(directory, 'lifecycle.json'),
    archiveRoot: join(directory, 'archives')
  }
}

function trackedPreparation(
  lifecycle: PreparationLifecycleStore,
  preparationId = 'prep-1',
  generation = GENERATION
): void {
  lifecycle.track({
    preparationId,
    ...generation,
    worktreeKey: `wt2:${generation.host}:${generation.instanceId}`
  })
  lifecycle.bindPane(preparationId, 'preparation', PANE)
}

function commitArchive(
  store: PreparationOutputStore,
  lifecycle: PreparationLifecycleStore,
  text: string,
  preparationId = 'prep-1',
  generation = GENERATION,
  inputRevision = 0
): string {
  const capture = new PreparationOutputCapture()
  capture.ingest({ startSequence: 0, endSequence: text.length, data: text })
  const committed = store.commit({
    identity: {
      preparationId,
      host: generation.host,
      worktreeKey: `wt2:${generation.host}:${generation.instanceId}`,
      instanceId: generation.instanceId,
      incarnationId: PANE.incarnationId
    },
    snapshot: capture.snapshot()
  })
  if (!committed.committed) {
    throw new Error(`commit refused: ${committed.reason}`)
  }
  lifecycle.recordArchive(preparationId, {
    archiveId: committed.archiveId,
    finalSequence: committed.finalSequence,
    inputRevision,
    durability: committed.durability
  })
  return committed.archiveId
}

it('keeps closure authority only while the durable snapshot still covers the pane, and tombstones a stop', () => {
  const { lifecycleFile, archiveRoot } = workspace()
  const lifecycle = new PreparationLifecycleStore({ filePath: lifecycleFile })
  const store = new PreparationOutputStore({ root: archiveRoot })
  trackedPreparation(lifecycle)
  expect(
    lifecycle.bindPane('prep-1', 'preparation', { ptyId: 'pty-prep', incarnationId: 'inc-2' })
  ).toBe(false)

  const first = commitArchive(store, lifecycle, 'done\n')
  expect(lifecycle.closureArchive('prep-1')).toMatchObject({ archiveId: first, finalSequence: 5 })

  // Later output invalidates that snapshot but a recapture can authorize again.
  lifecycle.recordOutput('prep-1', 7)
  expect(lifecycle.closureArchive('prep-1')).toBeNull()
  const second = commitArchive(store, lifecycle, 'done\n$ ')
  expect(lifecycle.closureArchive('prep-1')?.archiveId).toBe(second)

  // A failed stop keeps the archive and returns the preparation to observation.
  expect(lifecycle.beginClose('prep-1', first)).toBe(false)
  expect(lifecycle.beginClose('prep-1', second)).toBe(true)
  // A pending close must not race a setup re-enqueue into the pane it is stopping.
  expect(lifecycle.mayEnqueueSetup('prep-1')).toBe(false)
  lifecycle.settleClose('prep-1', 'failed')
  expect(lifecycle.mayEnqueueSetup('prep-1')).toBe(true)
  expect(lifecycle.get('prep-1')).toMatchObject({ state: 'observing', pendingClose: null })
  expect(store.read({ archiveId: second }).text).toBe('done\n$ ')

  expect(lifecycle.beginClose('prep-1', second)).toBe(true)
  lifecycle.settleClose('prep-1', 'stopped')
  expect(lifecycle.mayEnqueueSetup('prep-1')).toBe(false)

  const reopened = new PreparationLifecycleStore({ filePath: lifecycleFile })
  expect(reopened.get('prep-1')).toMatchObject({ state: 'retired', closureArchiveId: second })
  expect(reopened.mayEnqueueSetup('prep-1')).toBe(false)
  expect(reopened.closureArchive('prep-1')).toBeNull()
})

it('never recaptures closure permission after input or capture loss', () => {
  const { lifecycleFile, archiveRoot } = workspace()
  const lifecycle = new PreparationLifecycleStore({ filePath: lifecycleFile })
  const store = new PreparationOutputStore({ root: archiveRoot })
  trackedPreparation(lifecycle, 'prep-input')
  commitArchive(store, lifecycle, 'ready\n', 'prep-input')
  lifecycle.recordInput('prep-input', 1)
  commitArchive(store, lifecycle, 'ready\nls\n', 'prep-input')
  expect(lifecycle.get('prep-input')).toMatchObject({
    state: 'retained',
    retainedReason: 'input-after-snapshot'
  })
  expect(lifecycle.closureArchive('prep-input')).toBeNull()

  trackedPreparation(lifecycle, 'prep-gap')
  lifecycle.recordCaptureIncomplete('prep-gap', 'sequence-gap')
  commitArchive(store, lifecycle, 'partial\n', 'prep-gap')
  expect(lifecycle.closureArchive('prep-gap')).toBeNull()
  expect(lifecycle.get('prep-gap')).toMatchObject({ capture: 'sequence-gap', state: 'retained' })
})

it('durably retains when a later snapshot was fenced on input that arrived after an earlier one', () => {
  const { lifecycleFile, archiveRoot } = workspace()
  const lifecycle = new PreparationLifecycleStore({ filePath: lifecycleFile })
  const store = new PreparationOutputStore({ root: archiveRoot })
  trackedPreparation(lifecycle)
  const first = commitArchive(store, lifecycle, 'ready\n', 'prep-1', GENERATION, 3)
  expect(lifecycle.closureArchive('prep-1')?.archiveId).toBe(first)
  // A re-evaluation fences on the revision the user moved by typing between evaluations.
  commitArchive(store, lifecycle, 'ready\nls\n', 'prep-1', GENERATION, 4)
  expect(lifecycle.closureArchive('prep-1')).toBeNull()
  expect(lifecycle.beginClose('prep-1', first)).toBe(false)
  commitArchive(store, lifecycle, 'ready\nls\n$ ', 'prep-1', GENERATION, 4)
  expect(lifecycle.closureArchive('prep-1')).toBeNull()
  expect(new PreparationLifecycleStore({ filePath: lifecycleFile }).get('prep-1')).toMatchObject({
    state: 'retained',
    retainedReason: 'input-after-snapshot',
    closureArchiveId: null
  })
})

it('recovers only recorded incarnations and never reconstructs lost capture', () => {
  const { lifecycleFile, archiveRoot } = workspace()
  const lifecycle = new PreparationLifecycleStore({ filePath: lifecycleFile })
  const store = new PreparationOutputStore({ root: archiveRoot })
  trackedPreparation(lifecycle, 'prep-archived')
  commitArchive(store, lifecycle, 'setup done\n', 'prep-archived')
  trackedPreparation(lifecycle, 'prep-unarchived')
  trackedPreparation(lifecycle, 'prep-replaced')
  trackedPreparation(lifecycle, 'prep-closing-exited')
  const closingArchive = commitArchive(store, lifecycle, 'ok\n', 'prep-closing-exited')
  lifecycle.beginClose('prep-closing-exited', closingArchive)
  trackedPreparation(lifecycle, 'prep-closing-unknown')
  const unknownArchive = commitArchive(store, lifecycle, 'ok\n', 'prep-closing-unknown')
  lifecycle.beginClose('prep-closing-unknown', unknownArchive)

  // Every record shares PANE; the inspection answers per preparation through call order.
  const answers: PreparationPaneInspection[] = [
    { status: 'live', incarnationId: 'inc-1' },
    { status: 'live', incarnationId: 'inc-1' },
    { status: 'live', incarnationId: 'inc-replacement' },
    { status: 'exited' },
    { status: 'unverifiable' }
  ]
  const restartedLifecycle = new PreparationLifecycleStore({ filePath: lifecycleFile })
  const decisions = recoverPreparationLifecycle({
    lifecycle: restartedLifecycle,
    store: new PreparationOutputStore({ root: archiveRoot }),
    inspect: () => answers.shift()!
  })

  expect(decisions.map(({ preparationId, action }) => ({ preparationId, action }))).toEqual([
    { preparationId: 'prep-archived', action: 'reattach' },
    { preparationId: 'prep-unarchived', action: 'retain' },
    { preparationId: 'prep-replaced', action: 'retain' },
    { preparationId: 'prep-closing-exited', action: 'retired' },
    { preparationId: 'prep-closing-unknown', action: 'retain' }
  ])
  expect(decisions[1]).toMatchObject({ reason: 'capture-incomplete' })
  expect(decisions[2]).toMatchObject({ reason: 'ownership-changed' })
  expect(decisions[4]).toMatchObject({ reason: 'unverifiable' })
  expect(restartedLifecycle.get('prep-unarchived')).toMatchObject({ capture: 'missing-beginning' })
  expect(restartedLifecycle.get('prep-closing-exited')?.state).toBe('retired')
  expect(restartedLifecycle.get('prep-closing-unknown')).toMatchObject({
    state: 'retiring',
    pendingClose: { archiveId: unknownArchive, incarnationId: 'inc-1' }
  })

  const reattach = decisions[0]
  if (reattach?.action !== 'reattach') {
    throw new Error('expected reattach')
  }
  // The resumed capture continues exactly at the archive's provider offset, and nowhere else.
  reattach.capture.ingest({ startSequence: 11, endSequence: 13, data: '$ ' })
  expect(reattach.capture.snapshot()).toMatchObject({
    authoritative: true,
    text: 'setup done\n$ ',
    finalSequence: 13
  })
  const skipped = PreparationOutputCapture.resume({ text: 'setup done\n', finalSequence: 11 })
  skipped.ingest({ startSequence: 12, endSequence: 14, data: '$ ' })
  expect(skipped.snapshot()).toMatchObject({ authoritative: false, reason: 'sequence-gap' })
})

it('purges only a deleted generation and revokes reads while a failed purge is outstanding', () => {
  const { lifecycleFile, archiveRoot } = workspace()
  const lifecycle = new PreparationLifecycleStore({ filePath: lifecycleFile })
  const other = { host: 'localhost', instanceId: 'instance-2' }
  let failRemoval = true
  const filesystem: PreparationOutputFilesystem = {
    ...nodeFs,
    rmSync: (path, options) => {
      if (failRemoval && String(path).endsWith('.json')) {
        throw new Error('EBUSY')
      }
      nodeFs.rmSync(path, options)
    }
  }
  const store = new PreparationOutputStore({
    root: archiveRoot,
    filesystem,
    isGenerationRevoked: (host, instanceId) => lifecycle.isGenerationRevoked(host, instanceId)
  })
  trackedPreparation(lifecycle)
  const removed = commitArchive(store, lifecycle, 'first generation\n')
  trackedPreparation(lifecycle, 'prep-other', other)
  const kept = commitArchive(store, lifecycle, 'same path, new generation\n', 'prep-other', other)

  expect(purgeDeletedPreparationGeneration({ lifecycle, store, generation: GENERATION })).toEqual({
    purged: false
  })
  expect(() => store.read({ archiveId: removed })).toThrow('preparation_output_archive_unavailable')
  expect(store.list({ host: GENERATION.host, worktreeKey: WORKTREE_KEY })).toEqual([])
  expect(store.read({ archiveId: kept }).text).toBe('same path, new generation\n')

  failRemoval = false
  const restarted = new PreparationLifecycleStore({ filePath: lifecycleFile })
  expect(restarted.isGenerationRevoked(GENERATION.host, GENERATION.instanceId)).toBe(true)
  recoverPreparationLifecycle({
    lifecycle: restarted,
    store,
    inspect: () => ({ status: 'unverifiable' })
  })
  expect(restarted.deletionObligations()).toEqual([])
  expect(restarted.get('prep-1')).toBeNull()
  expect(restarted.get('prep-other')).not.toBeNull()
  expect(() => store.read({ archiveId: removed })).toThrow('preparation_output_archive_not_found')
  expect(store.read({ archiveId: kept }).text).toBe('same path, new generation\n')
})

it('refuses to start from unreadable lifecycle facts instead of resetting them', () => {
  const { lifecycleFile } = workspace()
  writeFileSync(lifecycleFile, '{"version":1,"records":[{"preparationId":')
  expect(() => new PreparationLifecycleStore({ filePath: lifecycleFile })).toThrow(
    'preparation_lifecycle_unreadable'
  )
})
