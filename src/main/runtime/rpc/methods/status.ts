import { defineMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'
import { getLongPollCapacityReport } from '../../runtime-rpc/runtime-rpc-long-poll-capacity'

export const STATUS_METHODS = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: async (_params, { runtime, pairedDeviceId }) => {
      // Why: a status answered while the friendly-name lookup is still in flight publishes the bare
      // hostname; the wait is capped below the CLI's status probe so a slow lookup never reads as down.
      await runtime.machineNameReady()
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
      // Why: a refused long-poll answers before any handler runs and writes
      // nothing anywhere else, so this is the only place an operator can see
      // that the runtime was at capacity. Rule 1 of
      // docs/reference/remote-wire-compatibility.md: additive and optional, so
      // an older peer ignores it. Absence carries meaning and must read as
      // UNKNOWN, never as "nothing was refused" — a host predating the field
      // omits it, and so does one whose RPC server never started. Hence
      // omitted, not `?? null`: collapsing the two would make a mixed-version
      // host indistinguishable from a runtime with an empty ledger.
      const longPollCapacity = getLongPollCapacityReport(runtime.getRuntimeId())
      return {
        ...runtime.getStatus(),
        ...(pairedDeviceId ? { pairedDeviceId } : {}),
        ...(longPollCapacity ? { longPollCapacity } : {}),
        appVersion: snapshot.appVersion,
        remoteUpdateSupport: snapshot.support
      }
    }
  })
]
