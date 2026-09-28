import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isDecPrivateModeOnlyChunk } from './dec-private-mode-chunk'
import { errorMessage, makeTuiIdleRuntime } from './tui-idle-wait-test-harness'
import type { RuntimeSyncWindowGraph } from '../../shared/runtime-types'

// OMP 18.4.1 re-asserts bracketed paste (`ESC[?2004h`) once a second while idle. Counted
// as output, it kept an idle OMP pane "streaming" forever, so `tui-idle` never settled and
// `worker-start` never pasted its brief.

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const BRACKETED_PASTE_ON = `${ESC}[?2004h`
const OMP_IDLE_TITLE = 'π > session'
const WORKTREE_ID = 'repo-1::/tmp/omp-mode-refresh'
const LEAF_ID = '44444444-4444-4444-8444-444444444444'
const PTY_ID = 'pty-omp-mode-refresh'
const REFRESH_INTERVAL_MS = 1000
// Comfortably past TUI_IDLE_QUIESCENCE_MS (3000) plus one idle-poll interval.
const REFRESH_TICKS = 8

const GRAPH = {
  tabs: [
    {
      tabId: 'tab-1',
      worktreeId: WORKTREE_ID,
      title: 'Agent',
      activeLeafId: LEAF_ID,
      layout: null
    }
  ],
  leaves: [
    {
      tabId: 'tab-1',
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneRuntimeId: 1,
      ptyId: PTY_ID,
      paneTitle: null,
      title: ''
    }
  ]
} satisfies RuntimeSyncWindowGraph

async function makeOmpPane() {
  const runtime = makeTuiIdleRuntime({
    repoPath: '/tmp/omp-mode-refresh',
    getForegroundProcess: async () => 'omp'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, GRAPH)
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
    tabId: 'tab-1',
    leafId: LEAF_ID,
    incarnationId: 'omp-incarnation',
    agentLaunchAuthority: { launchToken: 'omp-launch', launchAgent: 'omp' }
  })
  const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
  runtime.onPtyData(PTY_ID, `${ESC}]0;${OMP_IDLE_TITLE}${BEL}> \n`, Date.now())
  return { runtime, handle: terminals[0].handle }
}

function watch(promise: Promise<unknown>) {
  const settled = vi.fn()
  void promise.then(
    (value) => settled({ ok: value }),
    (error) => settled({ error: errorMessage(error) })
  )
  return settled
}

describe('tui-idle for an OMP pane that refreshes bracketed paste every second', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles once the quiescence window passes with only the mode refresh arriving', async () => {
    const { runtime, handle } = await makeOmpPane()
    const settled = watch(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    )

    for (let tick = 0; tick < REFRESH_TICKS; tick += 1) {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS)
      runtime.onPtyData(PTY_ID, BRACKETED_PASTE_ON, Date.now())
    }

    expect(settled).toHaveBeenCalledWith({
      ok: expect.objectContaining({ condition: 'tui-idle', satisfied: true })
    })
  })

  it('does not settle while real output keeps arriving alongside the refresh', async () => {
    const { runtime, handle } = await makeOmpPane()
    const settled = watch(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    )

    for (let tick = 0; tick < REFRESH_TICKS; tick += 1) {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS)
      runtime.onPtyData(PTY_ID, `${BRACKETED_PASTE_ON}streaming ${tick}\r\n`, Date.now())
    }

    expect(settled).not.toHaveBeenCalled()
  })
})

describe('isDecPrivateModeOnlyChunk', () => {
  it('accepts one or more private-mode set/reset sequences, multi-parameter included', () => {
    expect(isDecPrivateModeOnlyChunk(BRACKETED_PASTE_ON)).toBe(true)
    expect(isDecPrivateModeOnlyChunk(`${ESC}[?2004l${ESC}[?1049;1h${ESC}[?25l`)).toBe(true)
  })

  it.each([
    ['empty chunk', ''],
    ['mode plus text', `${BRACKETED_PASTE_ON}hello`],
    ['text plus mode', `>${BRACKETED_PASTE_ON}`],
    ['mode plus CUP position move', `${BRACKETED_PASTE_ON}${ESC}[2;5H`],
    ['mode plus SGR', `${BRACKETED_PASTE_ON}${ESC}[1;31m`],
    ['mode plus OSC title', `${BRACKETED_PASTE_ON}${ESC}]0;π > session${BEL}`],
    ['non-private mode set', `${ESC}[4h`],
    ['private mode without a parameter', `${ESC}[?h`]
  ])('rejects %s', (_label, chunk) => {
    expect(isDecPrivateModeOnlyChunk(chunk)).toBe(false)
  })
})
