import {
  registerEagerPtyBuffer,
  type EagerPtyHandle
} from '@/components/terminal-pane/pty-dispatcher'
import { useAppStore } from '@/store'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'

/** The id a background pane got, plus which lifetime of it this spawn owns. */
export type SpawnedPane = { ptyId: string; incarnationId?: string }

// Why fresh state: getState() is an immutable snapshot, and the pane exits long after launch —
// writing back a launch-time layout would drop every split and binding made since.
function persistExitedPaneOutput(tabId: string, leafId: string, output: string): void {
  const store = useAppStore.getState()
  const layout = store.terminalLayoutsByTabId[tabId]
  if (!layout) {
    return
  }
  const { ptyIdsByLeafId: existingPtyIds, buffersByLeafId: existingBuffers, ...rest } = layout
  const nextPtyIds = { ...existingPtyIds }
  delete nextPtyIds[leafId]
  const trimmedOutput = output.trim() ? output : ''
  const next: TerminalLayoutSnapshot = {
    ...rest,
    ...(Object.keys(nextPtyIds).length > 0 ? { ptyIdsByLeafId: nextPtyIds } : {}),
    ...(trimmedOutput
      ? { buffersByLeafId: { ...existingBuffers, [leafId]: output } }
      : existingBuffers
        ? { buffersByLeafId: existingBuffers }
        : {})
  }
  store.setTabLayout(tabId, next)
}

// Why the incarnation: a relay-recycled id can hold the previous owner's exit, and draining that
// into this handler tears the pane down seconds after it launched.
export function registerBackgroundPaneBuffer(
  tabId: string,
  leafId: string,
  pane: SpawnedPane
): void {
  let eagerBuffer: EagerPtyHandle | null = null
  const onExit = (exitPtyId: string): void => {
    persistExitedPaneOutput(tabId, leafId, eagerBuffer?.flush() ?? '')
    useAppStore.getState().clearTabPtyId(tabId, exitPtyId)
  }
  eagerBuffer = registerEagerPtyBuffer(pane.ptyId, onExit, pane.incarnationId)
}
