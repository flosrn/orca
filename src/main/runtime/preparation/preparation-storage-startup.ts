import { join } from 'node:path'

/**
 * Every runtime host (desktop, `serve`, orcad) opens preparation storage under its private
 * profile directory before PTY handlers replay output. Unreadable lifecycle facts leave the
 * runtime without storage: captures stay in memory and no archive-backed closure is possible.
 */
export function openRuntimePreparationStorage(
  runtime: { setPreparationStorage(options: { directory: string }): void },
  profileStorageDirectory: string
): void {
  try {
    runtime.setPreparationStorage({ directory: join(profileStorageDirectory, 'preparation') })
  } catch (error) {
    console.error('[preparation] storage unavailable; preparation cleanup stays disabled:', error)
  }
}

/**
 * Every runtime host runs this once its PTY providers can answer for their inventory (after the
 * daemon swap and PTY handler registration). A pane that crashed or stopped while its close was
 * outstanding is reconciled here even when nothing ever re-announces it.
 */
export async function recoverRuntimePreparationLifecycle(runtime: {
  recoverPreparationLifecycle(): Promise<unknown>
}): Promise<void> {
  try {
    await runtime.recoverPreparationLifecycle()
  } catch (error) {
    console.error(
      '[preparation] restart reconciliation failed; recorded panes stay retained:',
      error
    )
  }
}
