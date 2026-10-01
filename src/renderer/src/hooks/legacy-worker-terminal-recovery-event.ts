import type { CloseTerminalPaneDetail } from '@/constants/terminal'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { terminalSurfaceRetirementDetail } from './retire-terminal-surface-in-store'

type LegacyWorkerTerminalRecoveryEvent = {
  paneKey: string
  resolution: 'adopted' | 'exited' | 'rolled_back'
  ptyId?: string
}

export type LegacyWorkerTerminalRecoveryAction =
  | { kind: 'clear-sleeping'; paneKey: string }
  | { kind: 'rollback-surface'; detail: CloseTerminalPaneDetail }
  | { kind: 'ignore' }

export function resolveLegacyWorkerTerminalRecoveryAction(
  event: LegacyWorkerTerminalRecoveryEvent
): LegacyWorkerTerminalRecoveryAction {
  if (event.resolution !== 'rolled_back') {
    return { kind: 'clear-sleeping', paneKey: event.paneKey }
  }
  const pane = parsePaneKey(event.paneKey)
  return pane && event.ptyId
    ? {
        kind: 'rollback-surface',
        detail: terminalSurfaceRetirementDetail({
          tabId: pane.tabId,
          leafId: pane.leafId,
          ptyId: event.ptyId
        })
      }
    : { kind: 'ignore' }
}
