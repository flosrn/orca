// Carries the OMP root readiness receipt from a raw relay hook post onto the `agent.hook` channel.
// Status normalization discards unknown payload fields, so the receipt is read from the raw body.
import type { AgentHookRelayReadinessEnvelope, AgentHookSource } from '../shared/agent-hook-relay'
import { isRecord } from '../shared/agent-status-child-work-value-guards'
import {
  readPreparationRootReadiness,
  type PreparationRootReadiness
} from '../shared/preparation-root-readiness'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'

export function readRelayRootReadiness(hookBody: unknown): PreparationRootReadiness | null {
  return readPreparationRootReadiness(isRecord(hookBody) ? hookBody.payload : undefined)
}

/**
 * OMP's session_start carries no pane status, so the normalizer yields no event for it. An idle
 * root that never prompts only ever posts that, so its readiness must still cross the channel.
 */
export function buildRelayReadinessEnvelope(
  body: unknown,
  source: AgentHookSource,
  rootReadiness: PreparationRootReadiness
): AgentHookRelayReadinessEnvelope | null {
  if (!isRecord(body)) {
    return null
  }
  if (typeof body.paneKey !== 'string' || body.paneKey.trim().length === 0) {
    return null
  }
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined
  const launchToken = text(body.launchToken)
  return {
    source,
    paneKey: body.paneKey.trim(),
    ...(launchToken ? { launchToken } : {}),
    tabId: text(body.tabId),
    worktreeId: text(body.worktreeId),
    connectionId: null,
    hookEventName: isRecord(body.payload) ? text(body.payload.hook_event_name) : undefined,
    rootReadiness,
    env: hookBodyEnv(body),
    version: hookBodyVersion(body),
    payload: {}
  }
}

/** Forwards a receipt from a post that produced no status event, unless its pane is retired. */
export function forwardReadinessOnly(
  hookBody: unknown,
  source: AgentHookSource,
  rootReadiness: PreparationRootReadiness,
  forward: (envelope: AgentHookRelayReadinessEnvelope) => void,
  isPaneSurfaceRetired: (paneKey: string) => boolean
): void {
  const envelope = buildRelayReadinessEnvelope(hookBody, source, rootReadiness)
  if (envelope && !isPaneSurfaceRetired(envelope.paneKey)) {
    forward(envelope)
  }
}
