import { AGENT_SESSION_PREPARATION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { PreparationSpawnIntake } from '../../../shared/preparation-contracts'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { isRuntimeCompatBlockError } from './runtime-protocol-compat'

type PreparationOptions = { preparation?: PreparationSpawnIntake }

/** An older host's strict create schema would refuse the field; without the capability the pane
 *  still launches, unowned and therefore retained. */
export function createAgentSessionPreparationOptions() {
  let negotiated: Promise<PreparationOptions> | undefined
  return (
    environmentId: string,
    preparation: PreparationSpawnIntake | null
  ): Promise<PreparationOptions> => {
    // A replay must keep its original payload even after a host upgrade or reconnect.
    negotiated ??= (async () => {
      if (!preparation) {
        return {}
      }
      try {
        const supported = await runtimeEnvironmentSupportsCapability(
          environmentId,
          AGENT_SESSION_PREPARATION_RUNTIME_CAPABILITY
        )
        return supported ? { preparation } : {}
      } catch (error) {
        if (isRuntimeCompatBlockError(error)) {
          throw error
        }
        return {}
      }
    })()
    return negotiated
  }
}
