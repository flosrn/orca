import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { canonicalWorktreeIdentity } from '../../../../shared/worktree/identity'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { PreparationOutputCapture } from '../../preparation/preparation-output-capture'
import { PreparationOutputStore } from '../../preparation/preparation-output-store'
import type { RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'

const WORKTREE_ID = 'repo-1::/repo/wt'
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222'
const WORKTREE_KEY = canonicalWorktreeIdentity({
  worktreeId: WORKTREE_ID,
  executionHostId: 'local',
  instanceId: INSTANCE_ID
})

const ArchiveList = z.object({
  archives: z.array(z.object({ archiveId: z.string() }).passthrough())
})
const ArchivePage = z.object({
  archiveId: z.string(),
  offset: z.number(),
  text: z.string(),
  nextOffset: z.number().nullable()
})

let root: string
let store: PreparationOutputStore
let clock: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-preparation-output-rpc-'))
  clock = 1_711_000_000_000
  store = new PreparationOutputStore({ root: join(root, 'archives'), now: () => clock })
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function makeRuntime(worktree: Record<string, unknown> = defaultWorktree()) {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    showManagedWorktree: vi.fn().mockResolvedValue(worktree),
    getPreparationOutputStore: () => store,
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    createManagedWorktree: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reaches only the members stubbed above.
  const service = runtime as unknown as OrcaRuntimeService
  return { runtime, dispatcher: new RpcDispatcher({ runtime: service }) }
}

function defaultWorktree(): Record<string, unknown> {
  return { id: WORKTREE_ID, hostId: 'local', instanceId: INSTANCE_ID }
}

function request(method: string, params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function resultOf<T>(response: RpcResponse, schema: z.ZodType<T>): T {
  if (!response.ok) {
    throw new Error(`expected success, got ${response.error.code}`)
  }
  return schema.parse(response.result)
}

function commit(text: string, identity: { instanceId?: string; preparationId?: string } = {}) {
  const capture = new PreparationOutputCapture()
  if (text.length > 0) {
    capture.ingest({ startSequence: 0, endSequence: text.length, data: text })
  }
  const instanceId = identity.instanceId ?? INSTANCE_ID
  const result = store.commit({
    identity: {
      preparationId: identity.preparationId ?? `prep-${clock}`,
      host: 'local',
      worktreeKey: canonicalWorktreeIdentity({
        worktreeId: WORKTREE_ID,
        executionHostId: 'local',
        instanceId
      }),
      instanceId,
      incarnationId: `incarnation-${clock}`
    },
    snapshot: capture.snapshot()
  })
  if (!result.committed) {
    throw new Error(`fixture archive was not committed: ${result.reason}`)
  }
  clock += 1_000
  return result.archiveId
}

describe('preparation.output RPC', () => {
  it('distinguishes a worktree with no archive from an archive of empty successful output', async () => {
    const { runtime, dispatcher } = makeRuntime()

    const none = await dispatcher.dispatch(
      request('preparation.output.list', { worktree: `id:${WORKTREE_ID}` })
    )
    expect(none).toMatchObject({
      ok: true,
      result: {
        worktree: { worktreeId: WORKTREE_ID, hostId: 'local', worktreeKey: WORKTREE_KEY },
        archives: []
      }
    })

    const emptyId = commit('')
    const listed = await dispatcher.dispatch(
      request('preparation.output.list', { worktree: `id:${WORKTREE_ID}` })
    )
    expect(listed).toMatchObject({
      ok: true,
      result: {
        archives: [{ archiveId: emptyId, host: 'local', worktreeKey: WORKTREE_KEY, byteLength: 0 }]
      }
    })

    const read = await dispatcher.dispatch(
      request('preparation.output.read', { archiveId: emptyId })
    )
    expect(read).toMatchObject({
      ok: true,
      result: { archiveId: emptyId, offset: 0, text: '', nextOffset: null, byteLength: 0 }
    })
    expect(runtime.showManagedWorktree).toHaveBeenCalledWith(`id:${WORKTREE_ID}`)
  })

  it('lists only this host-qualified worktree generation, newest first', async () => {
    const { dispatcher } = makeRuntime()
    const older = commit('first run\n', { preparationId: 'prep-a' })
    commit('other generation\n', { instanceId: OTHER_INSTANCE_ID })
    const newer = commit('second run\n', { preparationId: 'prep-b' })

    const { archives } = resultOf(
      await dispatcher.dispatch(
        request('preparation.output.list', { worktree: `id:${WORKTREE_ID}` })
      ),
      ArchiveList
    )

    expect(archives.map((archive) => archive.archiveId)).toEqual([newer, older])
    expect(archives[0]).toMatchObject({
      preparationId: 'prep-b',
      host: 'local',
      instanceId: INSTANCE_ID,
      committedAt: expect.any(Number),
      redactionApplied: expect.any(Boolean)
    })
  })

  it('refuses a worktree without canonical host identity instead of reporting no output', async () => {
    const { dispatcher } = makeRuntime({ id: WORKTREE_ID, hostId: 'local' })
    commit('kept\n')

    const response = await dispatcher.dispatch(
      request('preparation.output.list', { worktree: `id:${WORKTREE_ID}` })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'preparation_output_worktree_identity_unavailable' }
    })
  })

  it('refuses traversal to a real archive of another store and never returns its text', async () => {
    const outside = new PreparationOutputStore({ root: join(root, 'outside'), now: () => clock })
    const secretCapture = new PreparationOutputCapture()
    secretCapture.ingest({ startSequence: 0, endSequence: 'secret\n'.length, data: 'secret\n' })
    const secret = outside.commit({
      identity: {
        preparationId: 'prep-outside',
        host: 'local',
        worktreeKey: WORKTREE_KEY,
        instanceId: INSTANCE_ID,
        incarnationId: 'incarnation-outside'
      },
      snapshot: secretCapture.snapshot()
    })
    if (!secret.committed) {
      throw new Error(`fixture archive was not committed: ${secret.reason}`)
    }
    const { dispatcher } = makeRuntime()

    for (const archiveId of [
      `../outside/${secret.archiveId}`,
      `..%2Foutside%2F${secret.archiveId}`,
      'not-a-uuid',
      'aaaaaaaa/..'
    ]) {
      const response = await dispatcher.dispatch(request('preparation.output.read', { archiveId }))
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'preparation_output_invalid_archive_id' }
      })
      expect(JSON.stringify(response)).not.toContain('secret')
    }
    outside.close()
  })

  it('reports an unknown well-formed archive id as not found, not as empty output', async () => {
    const { dispatcher } = makeRuntime()

    const response = await dispatcher.dispatch(
      request('preparation.output.read', { archiveId: '33333333-3333-4333-8333-333333333333' })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'preparation_output_archive_not_found' }
    })
  })

  it('pages a large archive in bounded byte pages without losing or duplicating lines', async () => {
    const lines = Array.from({ length: 4_000 }, (_, index) => `line-${index}-é漢😀`)
    const text = `${lines.join('\n')}\npartial-tail`
    const archiveId = commit(text)
    const { dispatcher } = makeRuntime()

    const pages: string[] = []
    let offset: number | null = 0
    let reads = 0
    while (offset !== null) {
      const page = resultOf(
        await dispatcher.dispatch(
          request('preparation.output.read', { archiveId, offset, limit: 4_096 })
        ),
        ArchivePage
      )
      expect(page).toMatchObject({ archiveId, offset })
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(4_096)
      if (page.nextOffset !== null) {
        expect(page.nextOffset).toBe(offset + Buffer.byteLength(page.text))
      }
      pages.push(page.text)
      offset = page.nextOffset
      reads += 1
      expect(reads).toBeLessThan(1_000)
    }

    expect(reads).toBeGreaterThan(1)
    expect(pages.join('')).toBe(text)

    const tooLarge = await dispatcher.dispatch(
      request('preparation.output.read', { archiveId, limit: 64 * 1024 + 1 })
    )
    expect(tooLarge).toMatchObject({ ok: false })
  })

  it('returns HTML and terminal escapes as inert text and never creates a terminal', async () => {
    const hostile =
      '<img src=x onerror=alert(1)>\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007\u001b[31mred\u001b[0m\n'
    const archiveId = commit(hostile)
    const { runtime, dispatcher } = makeRuntime()

    await dispatcher.dispatch(request('preparation.output.list', { worktree: `id:${WORKTREE_ID}` }))
    const page = resultOf(
      await dispatcher.dispatch(request('preparation.output.read', { archiveId })),
      ArchivePage
    )

    expect(page.text).toContain('<img src=x onerror=alert(1)>')
    expect(page.text).toContain('red')
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(runtime.splitTerminal).not.toHaveBeenCalled()
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })
})
