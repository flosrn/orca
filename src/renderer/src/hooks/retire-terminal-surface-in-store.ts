import type { CloseTerminalPaneDetail } from '@/constants/terminal'
import { detachTerminalLayoutLeaf } from '@/components/terminal-pane/terminal-layout-leaf-detach'
import type { AppState } from '@/store'
import { makePaneKey } from '../../../shared/stable-pane-id'

export type TerminalSurfaceRetirementStore = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'setTabLayout'
  | 'clearTabPtyId'
  | 'closeTab'
  | 'retireAgentPaneAuthority'
>

/** The pane-close event that removes a mounted leaf whose process main already stopped or rolled back. */
export function terminalSurfaceRetirementDetail(surface: {
  tabId: string
  leafId: string
  ptyId: string
}): CloseTerminalPaneDetail {
  return {
    tabId: surface.tabId,
    leafId: surface.leafId,
    preservePty: true,
    retireSurface: true,
    expectedPtyId: surface.ptyId
  }
}

/**
 * Removes one exact leaf from the store whether or not its tab is mounted, so a hidden split
 * never keeps (or re-persists) a retired surface. The tab closes only when no leaf remains.
 */
export function retireTerminalSurfaceInStore(
  store: TerminalSurfaceRetirementStore,
  detail: CloseTerminalPaneDetail
): 'removed' | 'already-removed' | 'identity-mismatch' {
  const tabExists = Object.values(store.tabsByWorktree).some((tabs) =>
    tabs.some((tab) => tab.id === detail.tabId)
  )
  if (!tabExists) {
    return 'already-removed'
  }
  if (!detail.leafId || !detail.expectedPtyId) {
    return 'identity-mismatch'
  }
  const layout = store.terminalLayoutsByTabId[detail.tabId]
  const boundPtyId = layout?.ptyIdsByLeafId?.[detail.leafId]
  if (!boundPtyId) {
    return 'already-removed'
  }
  if (boundPtyId !== detail.expectedPtyId) {
    return 'identity-mismatch'
  }
  const detached = detachTerminalLayoutLeaf(layout, detail.leafId)
  if (detached) {
    store.retireAgentPaneAuthority(makePaneKey(detail.tabId, detail.leafId), {
      preserveSleepingAgentSession: true
    })
    store.setTabLayout(detail.tabId, detached.sourceLayout)
    store.clearTabPtyId(detail.tabId, detail.expectedPtyId)
  } else {
    store.closeTab(detail.tabId, {
      reason: 'pty-exit',
      captureRecentlyClosed: false
    })
  }
  return 'removed'
}
