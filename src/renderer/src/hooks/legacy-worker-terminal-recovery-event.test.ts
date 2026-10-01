import { describe, expect, it } from 'vitest'
import { resolveLegacyWorkerTerminalRecoveryAction } from './legacy-worker-terminal-recovery-event'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

describe('legacy worker terminal recovery events', () => {
  it('removes a rolled-back surface without clearing its sleeping recovery fence', () => {
    expect(
      resolveLegacyWorkerTerminalRecoveryAction({
        paneKey: `legacy-worker:${LEAF_ID}`,
        resolution: 'rolled_back',
        ptyId: 'pty-legacy'
      })
    ).toEqual({
      kind: 'rollback-surface',
      detail: {
        tabId: 'legacy-worker',
        leafId: LEAF_ID,
        preservePty: true,
        retireSurface: true,
        expectedPtyId: 'pty-legacy'
      }
    })
  })

  it('clears sleeping recovery only after an adopted or exited resolution', () => {
    expect(
      resolveLegacyWorkerTerminalRecoveryAction({
        paneKey: `legacy-worker:${LEAF_ID}`,
        resolution: 'adopted'
      })
    ).toEqual({
      kind: 'clear-sleeping',
      paneKey: `legacy-worker:${LEAF_ID}`
    })
  })
})
