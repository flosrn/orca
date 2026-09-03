import { defineMethod, type RpcMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'
import { getLongPollCapacityReport } from '../../runtime-rpc/runtime-rpc-long-poll-capacity'

export const STATUS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: (_params, { runtime, pairedDeviceId }) => {
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
      // Why: optional field — a refused long-poll answers before any handler
      // runs and writes nothing anywhere else, so this is the only place an
      // operator can see that the runtime was at capacity. Absent on a runtime
      // whose RPC server never started.
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
