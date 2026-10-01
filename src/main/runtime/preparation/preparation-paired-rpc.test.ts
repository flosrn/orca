import type { WorktreeSetupLaunch } from '../../../shared/worktree/launch-types'
import { expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../rpc/core'
import { TERMINAL_METHODS } from '../rpc/methods/terminal'
import { AGENT_SESSION_METHODS } from '../rpc/methods/agent-session'
import { isRecord } from '../../../shared/agent-status-child-work-value-guards'

// Dynamic on purpose: vi.mock fragments must register before fixtures load (mocks, lifecycle, fixtures).
const { OrcaRuntimeService } = await import('../orca-runtime-test-mocks.spec')
await import('../orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID } = await import('../orca-runtime-test-fixtures.spec')

// A paired client's renderer fallback spawns its panes through runtime RPC, not local pty:spawn.
async function invokePaired(
  methods: readonly unknown[],
  name: string,
  params: unknown,
  runtime: InstanceType<typeof OrcaRuntimeService>
): Promise<unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both manifests are defineMethod arrays; eraseRpcMethods only widens their param types.
  const method = eraseRpcMethods(methods as never).find((candidate) => candidate.name === name)
  if (!method?.params || 'stream' in method) {
    throw new Error(`missing unary method ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only runtime and caller identity from the context.
  const context = { runtime, clientId: 'paired-client', clientKind: 'runtime' } as RpcContext
  return method.handler(method.params.parse(params), context)
}

/** Reads the created pane's handle, failing the test when the RPC result has another shape. */
function createdTerminalHandle(result: unknown): string {
  const terminal = isRecord(result) ? result.terminal : undefined
  if (!isRecord(terminal) || typeof terminal.handle !== 'string') {
    throw new Error(`terminal create returned no handle: ${JSON.stringify(result)}`)
  }
  return terminal.handle
}

function pairedRuntime(ptyIds: string[]) {
  const runtime = new OrcaRuntimeService({
    ...store,
    getSettings: () => ({ ...store.getSettings(), disabledTuiAgents: [] })
  })
  const spawn = vi.fn()
  for (const id of ptyIds) {
    spawn.mockResolvedValueOnce({ id, incarnationId: `${id}-inc` })
  }
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const registration = runtime.registerWorktreePreparation<WorktreeSetupLaunch>(
    { id: TEST_WORKTREE_ID, hostId: 'local', instanceId: '11111111-1111-4111-8111-111111111111' },
    { runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh', envVars: {} }
  )?.preparation
  if (!registration) {
    throw new Error('preparation was not registered')
  }
  return { runtime, spawn, preparationId: registration.preparationId }
}

it('binds a paired-client setup pane and agent pane to the preparation they carry over RPC', async () => {
  const { runtime, spawn, preparationId } = pairedRuntime(['pty-paired-setup', 'pty-paired-agent'])

  const setupHandle = createdTerminalHandle(
    await invokePaired(
      TERMINAL_METHODS,
      'terminal.create',
      {
        worktree: `id:${TEST_WORKTREE_ID}`,
        command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
        title: 'Setup',
        preparation: { preparationId, role: 'preparation' }
      },
      runtime
    )
  )
  const agentHandle = createdTerminalHandle(
    await invokePaired(
      AGENT_SESSION_METHODS,
      'terminal.createAgentSession',
      {
        clientOperationId: `${Date.now()}-${'cd'.repeat(16)}`,
        worktree: `id:${TEST_WORKTREE_ID}`,
        agent: 'codex',
        preparation: { preparationId, role: 'agent' }
      },
      runtime
    )
  )

  // The intake reaches the provider before its first byte, not after the ack.
  expect(spawn).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ preparation: { preparationId, role: 'preparation' } })
  )
  const [record] = runtime.listPreparationRecords()
  expect(record?.preparation).toMatchObject({
    handle: setupHandle,
    ptyId: 'pty-paired-setup',
    incarnationId: 'pty-paired-setup-inc'
  })
  expect(record?.agent).toMatchObject({
    handle: agentHandle,
    ptyId: 'pty-paired-agent',
    incarnationId: 'pty-paired-agent-inc'
  })
})

it('keeps an RPC pane without a preparation intake unowned', async () => {
  const { runtime } = pairedRuntime(['pty-paired-plain'])

  await invokePaired(
    TERMINAL_METHODS,
    'terminal.create',
    { worktree: `id:${TEST_WORKTREE_ID}`, command: 'pnpm dev', title: 'Setup' },
    runtime
  )

  expect(runtime.listPreparationRecords()).toEqual([
    expect.objectContaining({ preparation: null, agent: null })
  ])
})
