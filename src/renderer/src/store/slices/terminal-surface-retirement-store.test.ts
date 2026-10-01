import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  retireTerminalSurfaceInStore,
  terminalSurfaceRetirementDetail
} from '@/hooks/retire-terminal-surface-in-store'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = createStoreCascadesMockApi()
const WORKTREE = 'repo1::/path/wt1'
const SETUP_LEAF = '11111111-1111-4111-8111-111111111111'
const OMP_LEAF = '22222222-2222-4222-8222-222222222222'

function seededStore() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt1' })] }
  })
  return store
}

describe('canonical terminal surface retirement in an unmounted renderer store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('removes only the retired leaf of a hidden split and keeps the tab and its sibling', () => {
    const store = seededStore()
    const tab = store.getState().createTab(WORKTREE)
    store.setState({
      ptyIdsByTabId: { [tab.id]: ['pty-setup', 'pty-omp'] },
      terminalLayoutsByTabId: {
        [tab.id]: {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: SETUP_LEAF },
            second: { type: 'leaf', leafId: OMP_LEAF }
          },
          activeLeafId: OMP_LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [SETUP_LEAF]: 'pty-setup', [OMP_LEAF]: 'pty-omp' }
        }
      }
    })

    expect(
      retireTerminalSurfaceInStore(
        store.getState(),
        terminalSurfaceRetirementDetail({ tabId: tab.id, leafId: SETUP_LEAF, ptyId: 'pty-setup' })
      )
    ).toBe('removed')

    const state = store.getState()
    expect(state.tabsByWorktree[WORKTREE]?.map((entry) => entry.id)).toEqual([tab.id])
    expect(state.terminalLayoutsByTabId[tab.id]).toMatchObject({
      root: { type: 'leaf', leafId: OMP_LEAF },
      ptyIdsByLeafId: { [OMP_LEAF]: 'pty-omp' }
    })
    expect(state.ptyIdsByTabId[tab.id]).toEqual(['pty-omp'])
  })

  it('closes the tab when the retired leaf was its last one, without a recently-closed entry', () => {
    const store = seededStore()
    const tab = store.getState().createTab(WORKTREE)
    store.setState({
      ptyIdsByTabId: { [tab.id]: ['pty-setup'] },
      terminalLayoutsByTabId: {
        [tab.id]: {
          root: { type: 'leaf', leafId: SETUP_LEAF },
          activeLeafId: SETUP_LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [SETUP_LEAF]: 'pty-setup' }
        }
      }
    })

    retireTerminalSurfaceInStore(
      store.getState(),
      terminalSurfaceRetirementDetail({ tabId: tab.id, leafId: SETUP_LEAF, ptyId: 'pty-setup' })
    )

    expect(store.getState().tabsByWorktree[WORKTREE] ?? []).toEqual([])
    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WORKTREE]).toBeUndefined()
  })

  it('never removes a replacement that reused the same leaf', () => {
    const store = seededStore()
    const tab = store.getState().createTab(WORKTREE)
    const layout = {
      root: { type: 'leaf' as const, leafId: SETUP_LEAF },
      activeLeafId: SETUP_LEAF,
      expandedLeafId: null,
      ptyIdsByLeafId: { [SETUP_LEAF]: 'pty-replacement' }
    }
    store.setState({
      ptyIdsByTabId: { [tab.id]: ['pty-replacement'] },
      terminalLayoutsByTabId: { [tab.id]: layout }
    })

    expect(
      retireTerminalSurfaceInStore(
        store.getState(),
        terminalSurfaceRetirementDetail({ tabId: tab.id, leafId: SETUP_LEAF, ptyId: 'pty-setup' })
      )
    ).toBe('identity-mismatch')
    expect(store.getState().terminalLayoutsByTabId[tab.id]).toEqual(layout)
    expect(store.getState().tabsByWorktree[WORKTREE]?.map((entry) => entry.id)).toEqual([tab.id])
  })
})
