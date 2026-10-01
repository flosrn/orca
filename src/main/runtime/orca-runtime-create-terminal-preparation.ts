import type * as dependencies from './orca-runtime-create-terminal-dependencies'
import type { PreparationRecordStore } from './preparation/preparation-record-store'
import { registerPreparationAgent } from './preparation/preparation-observation'

type PreparationIntake = NonNullable<dependencies.TerminalCreateOptions['preparation']>

type PreparationRecords = Pick<PreparationRecordStore, 'reserve' | 'bind' | 'releaseReservation'>

export type ReservedPreparation = {
  preparation: PreparationIntake | undefined
  releaseIfUnbound: () => void
  bind: (binding: {
    handle: string
    ptyId: string
    incarnationId?: string
    tabId: string
    leafId: string
    paneKey: string
    launchToken?: string
  }) => void
}

/** Arms the pane identity before spawn and binds the live PTY, or releases the reservation. */
export function reservePreparationForTerminalCreate(
  records: PreparationRecords,
  intake: PreparationIntake | undefined,
  workspaceId: string,
  surface: { handle: string; tabId: string; leafId: string }
): ReservedPreparation {
  const preparation = intake && records.reserve(intake, workspaceId, surface) ? intake : undefined
  let bound = false
  return {
    preparation,
    releaseIfUnbound(): void {
      if (preparation && !bound) {
        records.releaseReservation(preparation, surface.handle)
      }
    },
    bind(binding): void {
      if (!preparation) {
        return
      }
      bound = records.bind(preparation, workspaceId, {
        handle: binding.handle,
        ptyId: binding.ptyId,
        incarnationId: binding.incarnationId ?? null,
        tabId: binding.tabId,
        leafId: binding.leafId,
        paneKey: binding.paneKey
      })
      if (
        bound &&
        preparation.role === 'agent' &&
        binding.paneKey &&
        binding.launchToken &&
        binding.incarnationId
      ) {
        registerPreparationAgent({
          preparationId: preparation.preparationId,
          paneKey: binding.paneKey,
          launchToken: binding.launchToken,
          incarnationId: binding.incarnationId,
          ptyId: binding.ptyId
        })
      }
    }
  }
}
