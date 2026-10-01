import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupCompletionTokens } from './preparation-setup-token-test-access.spec'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

// Dynamic on purpose: vi.mock fragments must register before the runtime fixtures load.
const {
  OrcaRuntimeService,
  computeWorktreePathMock,
  createSetupRunnerScript,
  ensurePathWithinWorkspaceMock,
  getEffectiveHooks,
  listWorktrees,
  shouldRunSetupForCreate
} = await import('../orca-runtime-test-mocks.spec')
await import('../orca-runtime-test-lifecycle.spec')
const { store } = await import('../orca-runtime-test-fixtures.spec')
const { AgentHookServer } = await import('../../agent-hooks/server')
const { preparationCleanupAuthorized, preparationFacts, resetPreparationObservationsForTests } =
  await import('./preparation-observation')

const SETUP_MARKER = '__ORCA_SETUP_COMPLETE__:'

type SpawnOptions = { command?: string; env?: Record<string, string | undefined> }

async function createPreparedRuntime(label: string, waitForAgentStartup: boolean) {
  const runtime = new OrcaRuntimeService(store)
  const path = `/tmp/workspaces/${label}`
  let agentEnv: Record<string, string | undefined> = {}
  const spawn = vi.fn(async (options: SpawnOptions) => {
    if (options.env?.ORCA_AGENT_LAUNCH_TOKEN) {
      agentEnv = options.env
    }
    if (options.command?.includes(SETUP_MARKER)) {
      return { id: `pty-setup-${label}`, incarnationId: `inc-setup-${label}` }
    }
    return { id: `pty-agent-${label}`, incarnationId: `inc-agent-${label}` }
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn().mockResolvedValue({ tabId: `tab-${label}` }),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  computeWorktreePathMock.mockReturnValue(path)
  ensurePathWithinWorkspaceMock.mockReturnValue(path)
  vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm worktree:setup' } })
  vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
  vi.mocked(createSetupRunnerScript).mockReturnValue({
    runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
    envVars: { ORCA_ROOT_PATH: '/tmp/repo', ORCA_WORKTREE_PATH: path },
    ...(waitForAgentStartup ? { waitForAgentStartup: true } : {})
  })
  vi.mocked(listWorktrees).mockResolvedValue([
    { path, head: 'def', branch: label, isBare: false, isMainWorktree: false }
  ])
  const result = await runtime.createManagedWorktree({
    repoSelector: 'id:repo-1',
    name: label,
    setupDecision: 'run',
    startup: { command: 'claude' },
    observeSetupCompletion: true,
    awaitTerminalProvisioning: true
  })
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
  const records = runtime.listPreparationRecords()
  const record = records.find((entry) => entry.agent?.ptyId === `pty-agent-${label}`)
  const token = setupCompletionTokens(runtime).get(`pty-setup-${label}`)
  return { runtime, result, record, token, agentEnv, setupPtyId: `pty-setup-${label}` }
}

async function startHookServer() {
  const server = new AgentHookServer()
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-prep-obs-'))
  await server.start({ env: 'production', userDataPath })
  return {
    server,
    userDataPath,
    stop() {
      server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }
}

async function postLocal(
  server: InstanceType<typeof AgentHookServer>,
  body: Record<string, unknown>,
  token = server.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN
) {
  const env = server.buildPtyEnv()
  return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/omp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Orca-Agent-Hook-Token': token } : {})
    },
    body: JSON.stringify(body)
  })
}

function readinessBody(paneKey: string, launchToken: string) {
  return {
    paneKey,
    launchToken,
    payload: {
      hook_event_name: 'session_start',
      root_session_ready: true,
      root_session_id: 'root-session-1',
      status_owner_module: '/opt/orca/extensions/orca-agent-status.ts'
    }
  }
}

describe('preparation observation through hook ingest and pty data', () => {
  const started: { stop: () => void }[] = []

  afterEach(() => {
    for (const server of started.splice(0)) {
      server.stop()
    }
    resetPreparationObservationsForTests()
  })

  it.each([
    ['start-immediately', false, 'preparation-before-agent', 'http'],
    ['wait-for-setup', true, 'agent-before-preparation', 'http'],
    ['start-immediately', false, 'agent-before-preparation', 'relay'],
    ['wait-for-setup', true, 'preparation-before-agent', 'relay']
  ] as const)(
    'records separate facts for %s when %s arrives via %s',
    async (label, waitForAgentStartup, order, transport) => {
      resetPreparationObservationsForTests()
      const created = await createPreparedRuntime(
        `${label}-${order}-${transport}`,
        waitForAgentStartup
      )
      const hook = await startHookServer()
      started.push(hook)
      expect(created.record?.preparationId).toEqual(expect.any(String))
      expect(created.token).toEqual(expect.any(String))
      const paneKey = created.agentEnv.ORCA_PANE_KEY
      const launchToken = created.agentEnv.ORCA_AGENT_LAUNCH_TOKEN
      expect(paneKey).toEqual(expect.any(String))
      expect(launchToken).toEqual(expect.any(String))
      const preparationId = created.record!.preparationId
      const body = readinessBody(paneKey!, launchToken!)
      const deliverAgent = async () => {
        if (transport === 'http') {
          const response = await postLocal(hook.server, body)
          expect(response.status).toBe(204)
          return
        }
        hook.server.ingestRemote(
          {
            paneKey: paneKey!,
            launchToken: launchToken!,
            hookEventName: 'session_start',
            payload: body.payload
          },
          'conn-prep'
        )
      }
      const deliverRunner = () => {
        created.runtime.onPtyData(
          created.setupPtyId,
          `${SETUP_MARKER}${created.token}:0\r\n`,
          Date.now()
        )
      }
      if (order === 'preparation-before-agent') {
        deliverRunner()
        expect(preparationFacts(preparationId).outcome?.status).toBe('succeeded')
        expect(preparationFacts(preparationId).takeover).toBeNull()
        expect(preparationCleanupAuthorized(preparationId)).toBe(false)
        await deliverAgent()
      } else {
        await deliverAgent()
        expect(preparationFacts(preparationId).takeover?.ready).toBe(true)
        expect(preparationFacts(preparationId).outcome).toBeNull()
        expect(preparationCleanupAuthorized(preparationId)).toBe(false)
        deliverRunner()
      }
      expect(preparationFacts(preparationId)).toEqual({
        outcome: { status: 'succeeded', token: created.token },
        takeover: {
          ready: true,
          rootSessionId: 'root-session-1',
          statusOwnerModule: '/opt/orca/extensions/orca-agent-status.ts',
          paneKey,
          launchToken,
          incarnationId: `inc-agent-${label}-${order}-${transport}`
        }
      })
      expect(preparationCleanupAuthorized(preparationId)).toBe(true)
    }
  )

  it('rejects an unauthenticated post and a child pane, then drops takeover when approval blocks', async () => {
    resetPreparationObservationsForTests()
    const created = await createPreparedRuntime('reject-child', false)
    const hook = await startHookServer()
    started.push(hook)
    const preparationId = created.record!.preparationId
    const paneKey = created.agentEnv.ORCA_PANE_KEY!
    const launchToken = created.agentEnv.ORCA_AGENT_LAUNCH_TOKEN!
    const refused = await postLocal(hook.server, readinessBody(paneKey, launchToken), 'wrong-token')
    expect(refused.status).toBe(403)
    hook.server.ingestRemote(
      {
        paneKey: 'child-pane',
        launchToken,
        hookEventName: 'session_start',
        payload: readinessBody(paneKey, launchToken).payload
      },
      'conn-child'
    )
    expect(preparationFacts(preparationId).takeover).toBeNull()
    const accepted = await postLocal(hook.server, readinessBody(paneKey, launchToken))
    expect(accepted.status).toBe(204)
    expect(preparationFacts(preparationId).takeover?.ready).toBe(true)
    const blocked = await postLocal(hook.server, {
      paneKey,
      launchToken,
      payload: { hook_event_name: 'tool_approval_requested', tool_name: 'bash' }
    })
    expect(blocked.status).toBe(204)
    expect(preparationFacts(preparationId).takeover).toBeNull()
    expect(preparationCleanupAuthorized(preparationId)).toBe(false)
  })
})
