import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createWorktreeIdentity } from '../../../shared/worktree/identity'
import type { PreparationSpawnIntake } from '../../../shared/preparation-contracts'
import type { PreparationOutputChunk } from './preparation-output-contracts'
import { PreparationOutputRuntime } from './preparation-output-runtime'
import { readArchiveText } from './preparation-recovery'
import { PreparationRecordStore } from './preparation-record-store'

const WORKTREE_ID = 'repo-1::/tmp/workspaces/prep-output'
const IDENTITY = createWorktreeIdentity({
  worktreeId: WORKTREE_ID,
  executionHostId: 'local',
  instanceId: 'instance-prep'
})

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function storageDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-preparation-runtime-'))
  directories.push(directory)
  return directory
}

/** Mirrors onPtyData: each chunk ends at the pty's cumulative provider offset. */
function providerStream(): (data: string) => PreparationOutputChunk {
  let sequence = 0
  return (data) => {
    const chunk = { startSequence: sequence, endSequence: sequence + data.length, data }
    sequence = chunk.endSequence
    return chunk
  }
}

function registerPreparation(records: PreparationRecordStore): PreparationSpawnIntake {
  const { preparationId } = records.register(IDENTITY, WORKTREE_ID)
  const intake: PreparationSpawnIntake = { preparationId, role: 'preparation' }
  expect(
    records.reserve(intake, WORKTREE_ID, { handle: 'term-prep', tabId: 'tab-1', leafId: 'leaf-1' })
  ).toBe(true)
  return intake
}

function bindPreparation(
  records: PreparationRecordStore,
  intake: PreparationSpawnIntake,
  ptyId: string
): void {
  expect(
    records.bind(intake, WORKTREE_ID, {
      handle: 'term-prep',
      ptyId,
      incarnationId: 'inc-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      paneKey: null
    })
  ).toBe(true)
}

it('captures provider bytes that arrive before the spawn acknowledgement, exactly once', () => {
  const directory = storageDirectory()
  const records = new PreparationRecordStore()
  const output = new PreparationOutputRuntime({ records })
  output.configureStorage({ directory })
  const intake = registerPreparation(records)

  const prep = providerStream()
  const shell = providerStream()
  const first = prep('preparation-first-byte\n')
  // Daemon/SSH stream data can beat the spawn reply; nothing binds it by title or path.
  output.observe('pty-prep', first)
  output.observe('pty-unrelated-shell', shell('shell started meanwhile\n'))
  output.observe('pty-prep', prep('installing\n'))
  bindPreparation(records, intake, 'pty-prep')
  // A replayed frame from reattach carries an already captured provider range.
  output.observe('pty-prep', first)
  output.observe('pty-prep', prep('done\n$ '))

  const committed = output.commit({ preparationId: intake.preparationId, inputRevision: 0 })
  expect(committed).toMatchObject({ committed: true })
  if (!committed.committed) {
    return
  }
  const store = output.outputStore()!
  expect(readArchiveText(store, committed.archiveId)).toBe(
    'preparation-first-byte\ninstalling\ndone\n$ '
  )
  expect(store.list({ host: 'local', worktreeKey: IDENTITY.key })).toEqual([
    expect.objectContaining({
      archiveId: committed.archiveId,
      preparationId: intake.preparationId,
      instanceId: 'instance-prep',
      incarnationId: 'inc-1'
    })
  ])
  expect(output.lifecycle()!.closureArchive(intake.preparationId)).toMatchObject({
    archiveId: committed.archiveId
  })
})

it('does not claim the beginning of output that arrived with no preparation pending', () => {
  const records = new PreparationRecordStore()
  const output = new PreparationOutputRuntime({ records })
  output.configureStorage({ directory: storageDirectory() })

  const prep = providerStream()
  output.observe('pty-prep', prep('emitted before any reservation\n'))
  const intake = registerPreparation(records)
  output.observe('pty-prep', prep('later\n'))
  bindPreparation(records, intake, 'pty-prep')
  output.observe('pty-prep', prep('after bind\n'))

  expect(output.commit({ preparationId: intake.preparationId, inputRevision: 0 })).toEqual({
    committed: false,
    reason: 'missing-beginning'
  })
  expect(output.lifecycle()!.get(intake.preparationId)).toMatchObject({
    state: 'retained',
    capture: 'missing-beginning'
  })
})

it('persists lifecycle facts across restart and resumes only the same live incarnation', async () => {
  const directory = storageDirectory()
  const records = new PreparationRecordStore()
  const output = new PreparationOutputRuntime({ records })
  output.configureStorage({ directory })
  const intake = registerPreparation(records)
  bindPreparation(records, intake, 'pty-prep')
  const prep = providerStream()
  output.observe('pty-prep', prep('setup done\n'))
  const committed = output.commit({ preparationId: intake.preparationId, inputRevision: 0 })
  expect(committed.committed).toBe(true)

  // Restart: the in-memory registration is gone; only the durable facts remain.
  const restarted = new PreparationOutputRuntime({ records: new PreparationRecordStore() })
  restarted.configureStorage({ directory })
  expect(restarted.lifecycle()!.get(intake.preparationId)).toMatchObject({
    host: 'local',
    worktreeKey: IDENTITY.key,
    instanceId: 'instance-prep',
    preparation: { ptyId: 'pty-prep', incarnationId: 'inc-1' }
  })
  const decisions = await restarted.recover(async () => ({
    status: 'live',
    incarnationId: 'inc-1'
  }))
  expect(decisions).toEqual([
    expect.objectContaining({ preparationId: intake.preparationId, action: 'reattach' })
  ])
  restarted.observe('pty-prep', prep('$ '))
  const recaptured = restarted.commit({ preparationId: intake.preparationId, inputRevision: 0 })
  expect(recaptured).toMatchObject({ committed: true, finalSequence: 'setup done\n$ '.length })
  if (recaptured.committed) {
    expect(readArchiveText(restarted.outputStore()!, recaptured.archiveId)).toBe('setup done\n$ ')
  }

  // A replacement incarnation after another restart is never adopted.
  const replaced = new PreparationOutputRuntime({ records: new PreparationRecordStore() })
  replaced.configureStorage({ directory })
  expect(await replaced.recover(async () => ({ status: 'live', incarnationId: 'inc-2' }))).toEqual([
    expect.objectContaining({ action: 'retain', reason: 'ownership-changed' })
  ])
  replaced.observe('pty-prep', prep('replacement output\n'))
  expect(replaced.commit({ preparationId: intake.preparationId, inputRevision: 0 })).toMatchObject({
    committed: false
  })
})

it('restart recovery leaves an unverifiable pane awaiting its exact re-announcement', async () => {
  const directory = storageDirectory()
  const records = new PreparationRecordStore()
  const output = new PreparationOutputRuntime({ records })
  output.configureStorage({ directory })
  const intake = registerPreparation(records)
  bindPreparation(records, intake, 'pty-prep')
  const prep = providerStream()
  output.observe('pty-prep', prep('setup done\n'))
  expect(output.commit({ preparationId: intake.preparationId, inputRevision: 0 }).committed).toBe(
    true
  )

  const restarted = new PreparationOutputRuntime({ records: new PreparationRecordStore() })
  restarted.configureStorage({ directory })
  expect(await restarted.recover(async () => ({ status: 'unverifiable' }))).toEqual([
    { preparationId: intake.preparationId, action: 'retain', reason: 'unverifiable' }
  ])
  expect(restarted.lifecycle()!.get(intake.preparationId)?.state).toBe('observing')

  // The provider re-announces the exact incarnation later: capture resumes where it stopped.
  restarted.confirmIncarnation('pty-prep', 'inc-1')
  restarted.observe('pty-prep', prep('$ '))
  // A recovery pass after the re-announcement leaves the reattached pane alone.
  expect(await restarted.recover(async () => ({ status: 'exited' }))).toEqual([])
  expect(restarted.commit({ preparationId: intake.preparationId, inputRevision: 0 })).toMatchObject(
    {
      committed: true,
      finalSequence: 'setup done\n$ '.length
    }
  )
})
