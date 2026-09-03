import { defineMethod, type RpcMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'
import { getLongPollCapacityReport } from '../../runtime-rpc/runtime-rpc-long-poll-capacity'

export const STATUS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: (_params, { runtime, pairedDeviceId }) => {
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
