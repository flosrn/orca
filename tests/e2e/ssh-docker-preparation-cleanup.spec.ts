import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { isRecord } from '../../src/shared/agent-status-child-work-value-guards'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  shellQuote,
  startDockerSshRelayTarget,
  writeDockerSshRelayTargetFile,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const cliEntry = path.join(process.cwd(), 'out', 'cli', 'index.js')

/**
 * Stand-in for OMP on the SSH host. Orca's shell wrapper hands the managed status extension to
 * `omp` with `--extension`; this loads that exact file the way OMP's loader does (module-scoped
 * `__filename`/`require`) and starts one idle root session without a prompt, so the extension
 * itself decides whether to post the root readiness receipt. It then stays alive like an agent.
 */
const FAKE_OMP_SOURCE = `#!/usr/bin/env node
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const args = process.argv.slice(2)
const flag = args.indexOf('--extension')
const extension = flag >= 0 ? args[flag + 1] : null
const keepAlive = () => setInterval(() => {}, 1 << 30)
if (!extension) {
  console.log('E2E_OMP_NO_EXTENSION')
  keepAlive()
} else {
  globalThis.__filename = extension
  globalThis.require = createRequire(extension)
  ;(async () => {
    const mod = await import(pathToFileURL(extension).href)
    const handlers = new Map()
    mod.default({
      on(name, handler) {
        if (!handlers.has(name)) handlers.set(name, [])
        handlers.get(name).push(handler)
      }
    })
    const sessionId = randomUUID()
    const ctx = {
      agent: { kind: 'main' },
      hasUI: false,
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
      isIdle: () => true
    }
    for (const handler of handlers.get('session_start') || []) await handler({}, ctx)
    console.log('E2E_OMP_SESSION_STARTED ' + sessionId)
    process.stdin.on('data', () => console.log('E2E_OMP_STILL_WORKING'))
    keepAlive()
  })().catch((error) => {
    console.log('E2E_OMP_LOAD_FAILED ' + (error && error.stack ? error.stack : error))
    keepAlive()
  })
}
`

type Policy = 'start-immediately' | 'wait-for-setup'

type CreatedWorktree = {
  worktree: { id: string }
  startupTerminal?: { handle?: string }
}

type TerminalRow = { handle: string; ptyId: string | null; title: string | null }

type ArchiveEntry = { archiveId: string; host: string }
type ArchiveList = { archives: ArchiveEntry[] }

type ArchivePage = { text: string; nextOffset: number | null }

/** Narrows `preparation output list --json`, failing the test on any other shape. */
function readArchiveList(value: unknown): ArchiveList {
  const archives = isRecord(value) && Array.isArray(value.archives) ? value.archives : null
  if (!archives) {
    throw new Error(`preparation output list returned no archives: ${JSON.stringify(value)}`)
  }
  return {
    archives: archives.map((entry): ArchiveEntry => {
      if (
        !isRecord(entry) ||
        typeof entry.archiveId !== 'string' ||
        typeof entry.host !== 'string'
      ) {
        throw new Error(`malformed archive entry: ${JSON.stringify(entry)}`)
      }
      return { archiveId: entry.archiveId, host: entry.host }
    })
  }
}

/** Narrows `preparation output read --json`, failing the test on any other shape. */
function readArchivePage(value: unknown): ArchivePage {
  if (
    !isRecord(value) ||
    typeof value.text !== 'string' ||
    (value.nextOffset !== null && typeof value.nextOffset !== 'number')
  ) {
    throw new Error(`preparation output read returned no page: ${JSON.stringify(value)}`)
  }
  return { text: value.text, nextOffset: value.nextOffset }
}

/** Three steps; the third refuses in a worktree whose path names `fail`. */
function orcaYaml(policy: Policy): string {
  return [
    `setupAgentStartupPolicy: ${policy}`,
    'scripts:',
    '  setup: |',
    '    echo PREP_STEP_1_OF_3',
    '    sleep 1',
    '    echo PREP_STEP_2_OF_3',
    '    sleep 1',
    '    case "$ORCA_WORKTREE_PATH" in *fail*) echo PREP_STEP_3_FAILED; exit 3;; esac',
    '    echo PREP_STEP_3_OF_3',
    ''
  ].join('\n')
}

function commitOrcaYaml(target: DockerSshRelayTarget, policy: Policy): void {
  writeDockerSshRelayTargetFile(
    target,
    `${DOCKER_SSH_RELAY_REMOTE_REPO_PATH}/orca.yaml`,
    orcaYaml(policy)
  )
  execDockerSshRelayTargetCommand(
    target,
    `cd ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)} && git add orca.yaml && git commit -qm ${shellQuote(`setup ${policy}`)}`
  )
}

// Why the CLI's client, not the renderer bridge: `worktree.create` from the renderer requires an
// authenticated device identity, while a worker/CLI create authenticates through the runtime socket.
async function listHandles(client: RuntimeClient, worktreeId: string): Promise<TerminalRow[]> {
  const listed = await client.call<{ terminals: TerminalRow[] }>('terminal.list', {
    worktree: `id:${worktreeId}`,
    limit: 50
  })
  return listed.result.terminals
}

async function readTail(client: RuntimeClient, handle: string): Promise<string> {
  const read = await client.call<{ terminal: { tail: string[] } }>('terminal.read', {
    terminal: handle
  })
  return read.result.terminal.tail.join('\n')
}

function orcaCli(userDataDir: string, args: string[]): unknown {
  const result = spawnSync(process.execPath, [cliEntry, ...args, '--json'], {
    env: { ...process.env, ORCA_USER_DATA_PATH: userDataDir, ORCA_DEV_CLI_INVOCATION: '1' },
    encoding: 'utf8',
    timeout: 60_000
  })
  if (result.status !== 0) {
    throw new Error(
      `orca ${args.join(' ')} exited ${result.status}: ${result.stdout}${result.stderr}`
    )
  }
  const parsed: unknown = JSON.parse(result.stdout)
  if (!isRecord(parsed)) {
    throw new Error(`orca ${args.join(' ')} printed no JSON object: ${result.stdout}`)
  }
  return parsed.result
}

async function createPreparedWorktree(
  client: RuntimeClient,
  repoId: string,
  name: string
): Promise<{ worktreeId: string; setup: string; agent: string }> {
  const { result: created } = await client.call<CreatedWorktree>('worktree.create', {
    repo: `id:${repoId}`,
    name,
    setupDecision: 'run',
    startupCommand: 'omp',
    activate: false,
    noParent: true
  })
  const agent = created.startupTerminal?.handle
  if (!agent) {
    throw new Error(`create returned no agent handle: ${JSON.stringify(created)}`)
  }
  // Why from the listing: the RPC create does not wait for provisioning, so it names no Setup
  // handle. The Setup pane is the worktree's other terminal, identified by its runner's output.
  let setup: string | undefined
  await expect
    .poll(
      async () => {
        try {
          for (const row of await listHandles(client, created.worktree.id)) {
            if (
              row.handle !== agent &&
              (await readTail(client, row.handle)).includes('PREP_STEP_1_OF_3')
            ) {
              setup = row.handle
            }
          }
        } catch (error) {
          // Provisioning publishes terminal surface ownership asynchronously after create returns.
          if (
            !(error instanceof Error) ||
            !error.message.includes('terminal_surface_ownership_unavailable')
          ) {
            throw error
          }
        }
        return setup ?? null
      },
      { timeout: 60_000, message: `${name}: no Setup pane printed the first step` }
    )
    .not.toBeNull()
  return { worktreeId: created.worktree.id, setup: setup!, agent }
}

test.describe('Docker SSH preparation cleanup', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH relay tests.')
  test.skip(process.platform === 'win32', 'Docker SSH relay tests use POSIX ssh tooling.')

  test('retires only the finished Setup leaf on the SSH host, keeps its archive readable, and keeps a failed Setup', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    test.setTimeout(420_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      writeDockerSshRelayTargetFile(target, '/usr/local/bin/omp', FAKE_OMP_SOURCE)
      execDockerSshRelayTargetCommand(target, 'chmod +x /usr/local/bin/omp')
      commitOrcaYaml(target, 'start-immediately')

      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      const client = new RuntimeClient(userDataDir, 60_000, null, null)

      const expectRetired = async (
        created: { worktreeId: string; setup: string; agent: string },
        label: string
      ): Promise<void> => {
        await expect
          .poll(async () => readTail(client, created.agent), {
            timeout: 60_000,
            message: `${label}: the agent never started a root session with the managed extension`
          })
          .toContain('E2E_OMP_SESSION_STARTED')
        await expect
          .poll(async () => (await listHandles(client, created.worktreeId)).map((t) => t.handle), {
            timeout: 90_000,
            message: `${label}: the finished Setup leaf was not retired`
          })
          .not.toContain(created.setup)
        expect((await listHandles(client, created.worktreeId)).map((t) => t.handle)).toContain(
          created.agent
        )
        // The agent pane survived the cleanup and is still the live OMP process.
        expect(await readTail(client, created.agent)).not.toContain('E2E_OMP_NO_EXTENSION')
        await client.call('terminal.send', {
          terminal: created.agent,
          text: 'still alive',
          enter: true
        })
        await expect
          .poll(() => readTail(client, created.agent), { timeout: 10_000 })
          .toContain('E2E_OMP_STILL_WORKING')

        const listed = readArchiveList(
          orcaCli(userDataDir, [
            'preparation',
            'output',
            'list',
            '--worktree',
            `id:${created.worktreeId}`
          ])
        )
        expect(listed.archives, `${label}: archives`).toHaveLength(1)
        expect(listed.archives[0]!.host).not.toBe('local')
        const read = readArchivePage(
          orcaCli(userDataDir, [
            'preparation',
            'output',
            'read',
            '--archive',
            listed.archives[0]!.archiveId
          ])
        )
        for (const step of ['PREP_STEP_1_OF_3', 'PREP_STEP_2_OF_3', 'PREP_STEP_3_OF_3']) {
          expect(read.text, `${label}: archived output`).toContain(step)
        }
        testInfo.annotations.push({
          type: 'docker-ssh-preparation-retired',
          description: `${label} target=${remote.targetId} worktree=${created.worktreeId} setup=${created.setup} agent=${created.agent} archive=${listed.archives[0]!.archiveId} host=${listed.archives[0]!.host}`
        })
      }

      const failing = await createPreparedWorktree(client, remote.repoId, `prep-fail-${Date.now()}`)
      await expect
        .poll(async () => readTail(client, failing.setup), {
          timeout: 60_000,
          message: 'the failing runner never reached its third step'
        })
        .toContain('PREP_STEP_3_FAILED')
      await expect
        .poll(async () => readTail(client, failing.agent), { timeout: 60_000 })
        .toContain('E2E_OMP_SESSION_STARTED')
      // Longer than a successful retirement takes above; the failed Setup must still be there.
      await orcaPage.waitForTimeout(10_000)
      expect((await listHandles(client, failing.worktreeId)).map((t) => t.handle)).toEqual(
        expect.arrayContaining([failing.setup, failing.agent])
      )
      expect(
        readArchiveList(
          orcaCli(userDataDir, [
            'preparation',
            'output',
            'list',
            '--worktree',
            `id:${failing.worktreeId}`
          ])
        ).archives
      ).toEqual([])
      const immediate = await createPreparedWorktree(
        client,
        remote.repoId,
        `prep-immediate-${Date.now()}`
      )
      await expectRetired(immediate, 'start-immediately')

      commitOrcaYaml(target, 'wait-for-setup')
      const gated = await createPreparedWorktree(client, remote.repoId, `prep-gated-${Date.now()}`)
      await expectRetired(gated, 'wait-for-setup')
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
