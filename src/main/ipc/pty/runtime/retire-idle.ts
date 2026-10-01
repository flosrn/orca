import type { IPtyProvider } from '../../../providers/types'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import {
  retainPty,
  type PtyIdleRetirementRequest,
  type PtyIdleRetirementResult
} from '../../../../shared/pty-idle-retirement'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { getProvider, getProviderForPty } from '../provider/registry'
import { delay } from '../provider/liveness'
import type { PtyRuntimeControllerDeps } from './controller-deps'

/**
 * Routes an automatic-cleanup stop to the provider that owns `ptyId` and lets that provider (or
 * its host) decide. Never falls back to `shutdown`: a provider without enforcement retains.
 */
export async function retireIdlePtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  request: PtyIdleRetirementRequest
): Promise<PtyIdleRetirementResult> {
  const { runtime, store, getLocalPtyProviderStartupPromise, finishPtyShutdown } = deps
  const recordedIncarnationId = ptyIncarnationById.get(ptyId)
  if (
    recordedIncarnationId !== undefined &&
    recordedIncarnationId !== request.expectedIncarnationId
  ) {
    return retainPty('incarnation_mismatch')
  }
  let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
  const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
  connectionId ??= parsedSshId?.connectionId
  const startupPromise = getLocalPtyProviderStartupPromise(connectionId)
  if (startupPromise) {
    const started = await Promise.race([
      startupPromise.then(
        () => true,
        () => false
      ),
      ...(request.deadlineMs === undefined
        ? []
        : [delay(Math.max(1, request.deadlineMs - Date.now())).then(() => false)])
    ])
    if (!started) {
      return retainPty('unverifiable')
    }
  }
  let provider: IPtyProvider
  try {
    provider = connectionId ? getProvider(connectionId) : getProviderForPty(ptyId)
  } catch {
    return retainPty('unverifiable')
  }
  if (!provider.retireIdle) {
    return retainPty('unsupported')
  }
  let providerExitObserved = false
  const unsubscribe = provider.onExit((payload) => {
    if (payload.id === ptyId && payload.incarnationId === request.expectedIncarnationId) {
      providerExitObserved = true
    }
  })
  let result: PtyIdleRetirementResult
  try {
    result = await provider.retireIdle(ptyId, request)
  } finally {
    unsubscribe()
  }
  if (result.outcome === 'unconfirmed' && connectionId) {
    runtime?.markPtyLivenessUnverifiable?.(ptyId, 'idle retirement stop unconfirmed')
  }
  if (result.outcome !== 'stopped' && result.outcome !== 'exited') {
    return result
  }
  const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
  if (!providerExitObserved) {
    // The owning host confirmed this exact incarnation gone; settle it as its exit would have.
    runtime?.onPtyExit(ptyId, 0, incarnationId)
    deps.rememberSyntheticKillExit(ptyId, incarnationId)
    deps.sendPtyExitToRenderer({ id: ptyId, code: 0, ...(incarnationId ? { incarnationId } : {}) })
  }
  return result
}
