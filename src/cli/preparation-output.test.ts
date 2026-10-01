import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { RuntimeRpcFailureError } from './runtime/types'
import { okFixture } from './test-fixtures'

const WORKTREE = 'id:repo-1::/repo/wt'
const ARCHIVE_ID = '33333333-3333-4333-8333-333333333333'
const WORKTREE_RESULT = {
  worktreeId: 'repo-1::/repo/wt',
  hostId: 'local',
  instanceId: '11111111-1111-4111-8111-111111111111',
  worktreeKey: 'wt2:local:11111111-1111-4111-8111-111111111111'
}

function page(offset: number, text: string, nextOffset: number | null, byteLength: number) {
  return okFixture('req_read', {
    archiveId: ARCHIVE_ID,
    offset,
    text,
    nextOffset,
    byteLength,
    committedAt: 1_711_000_000_000,
    redactionApplied: true
  })
}

function printed(logSpy: { mock: { calls: unknown[][] } }): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n')
}

function rpcCalls(): unknown[][] {
  return callMock.mock.calls.filter(([method]) => String(method).startsWith('preparation.output.'))
}

describe('orca preparation output', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('lists archives through preparation.output.list and prints the RPC result unchanged in json', async () => {
    const result = {
      worktree: WORKTREE_RESULT,
      archives: [
        {
          archiveId: ARCHIVE_ID,
          preparationId: 'prep-1',
          host: 'local',
          worktreeKey: WORKTREE_RESULT.worktreeKey,
          instanceId: WORKTREE_RESULT.instanceId,
          incarnationId: 'incarnation-1',
          committedAt: 1_711_000_000_000,
          byteLength: 12,
          finalSequence: 12,
          durability: 'established',
          redactionApplied: true
        }
      ]
    }
    callMock.mockResolvedValueOnce(okFixture('req_list', result))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['preparation', 'output', 'list', '--worktree', WORKTREE, '--json'], '/tmp/repo')

    expect(process.exitCode ?? 0).toBe(0)
    expect(rpcCalls()).toEqual([
      ['preparation.output.list', expect.objectContaining({ worktree: WORKTREE })]
    ])
    expect(JSON.parse(printed(logSpy)).result).toEqual(result)
  })

  it('says no archive exists instead of printing an empty list', async () => {
    callMock.mockResolvedValueOnce(
      okFixture('req_list', { worktree: WORKTREE_RESULT, archives: [] })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['preparation', 'output', 'list', '--worktree', WORKTREE], '/tmp/repo')

    expect(process.exitCode ?? 0).toBe(0)
    expect(printed(logSpy)).toMatch(/no preparation output/i)
  })

  it('reads every page of an archive once, in order, without duplication', async () => {
    callMock
      .mockResolvedValueOnce(page(0, 'line-1\nli', 9, 22))
      .mockResolvedValueOnce(page(9, 'ne-2\nline-3', 20, 22))
      .mockResolvedValueOnce(page(20, '\n!', null, 22))
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['preparation', 'output', 'read', '--archive', ARCHIVE_ID, '--all'], '/tmp/repo')

    expect(process.exitCode ?? 0).toBe(0)
    expect(rpcCalls()).toEqual([
      ['preparation.output.read', expect.objectContaining({ archiveId: ARCHIVE_ID, offset: 0 })],
      ['preparation.output.read', expect.objectContaining({ archiveId: ARCHIVE_ID, offset: 9 })],
      ['preparation.output.read', expect.objectContaining({ archiveId: ARCHIVE_ID, offset: 20 })]
    ])
    const output = `${writeSpy.mock.calls.map((call) => String(call[0])).join('')}${printed(logSpy)}`
    expect(output).toContain('line-1\nline-2\nline-3\n!')
    expect(output.match(/line-2/g)).toHaveLength(1)
  })

  it('passes one bounded page request through and prints the page in json', async () => {
    callMock.mockResolvedValueOnce(page(9, 'ne-2\nline-3', 20, 22))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'preparation',
        'output',
        'read',
        '--archive',
        ARCHIVE_ID,
        '--offset',
        '9',
        '--limit',
        '11',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(rpcCalls()).toEqual([
      ['preparation.output.read', { archiveId: ARCHIVE_ID, offset: 9, limit: 11 }]
    ])
    expect(JSON.parse(printed(logSpy)).result).toMatchObject({
      text: 'ne-2\nline-3',
      nextOffset: 20
    })
  })

  it('prints archived terminal escapes as inert text in human mode', async () => {
    const hostile =
      '<b>html</b>\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 \u001b[31mred\u001b[0m\n'
    callMock.mockResolvedValueOnce(page(0, hostile, null, Buffer.byteLength(hostile)))
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['preparation', 'output', 'read', '--archive', ARCHIVE_ID], '/tmp/repo')

    const output = `${writeSpy.mock.calls.map((call) => String(call[0])).join('')}${printed(logSpy)}`
    expect(output).toContain('<b>html</b>')
    expect(output).toContain('red')
    expect(output).not.toContain('\u001b')
    expect(output).not.toContain('\u0007')
  })

  it('surfaces an invalid archive id as its explicit error code', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_read',
        ok: false,
        error: {
          code: 'preparation_output_invalid_archive_id',
          message: 'preparation_output_invalid_archive_id'
        },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['preparation', 'output', 'read', '--archive', '../outside/secret', '--json'],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(printed(logSpy)).error.code).toBe('preparation_output_invalid_archive_id')
  })

  it('never calls terminal or setup methods to read an archive', async () => {
    callMock.mockResolvedValueOnce(page(0, 'done\n', null, 5))
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['preparation', 'output', 'read', '--archive', ARCHIVE_ID, '--all'], '/tmp/repo')

    const methods = callMock.mock.calls.map(([method]) => String(method))
    expect(methods.filter((method) => /^(terminal|worktree)\./.test(method))).toEqual([])
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each([
    ['list', ['preparation', 'output', 'list', '--worktree', WORKTREE, '--json']],
    ['read', ['preparation', 'output', 'read', '--archive', ARCHIVE_ID, '--json']]
  ])('names an older Orca server as a version gap for %s', async (verb, argv) => {
    callMock.mockImplementation(async (method: string) => {
      if (String(method).startsWith('preparation.output.')) {
        throw new RuntimeRpcFailureError({
          id: 'req_old',
          ok: false,
          error: {
            code: 'method_not_found',
            message: `Unknown method: preparation.output.${verb}`
          },
          _meta: { runtimeId: 'runtime-1' }
        })
      }
      return okFixture('req_worktree', { worktree: WORKTREE_RESULT })
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(argv, '/tmp/repo')

    expect(process.exitCode).toBe(1)
    const { error } = JSON.parse(printed(logSpy))
    expect(error.code).toBe('incompatible_runtime')
    expect(error.message).toMatch(/update orca on the server/i)
  })
})
