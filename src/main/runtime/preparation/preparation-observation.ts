import { createSetupCompletionScanner } from '../orchestration/setup-completion-signal'
import { readPreparationRootReadiness } from '../../../shared/preparation-root-readiness'
import { isRecord } from '../../../shared/agent-status-child-work-value-guards'

export type PreparationAgentMatch = {
  preparationId: string
  paneKey: string
  launchToken: string
  incarnationId: string
  ptyId: string
}

export type PreparationTakeover = {
  ready: true
  rootSessionId: string
  statusOwnerModule: string
  paneKey: string
  launchToken: string
  incarnationId: string
}

export type PreparationOutcome = {
  status: 'succeeded' | 'failed'
  token: string
}

type Facts = {
  outcome: PreparationOutcome | null
  takeover: PreparationTakeover | null
}

const agents = new Map<string, PreparationAgentMatch>()
const facts = new Map<string, Facts>()
const scanners = new Map<string, { scan: (data: string) => void }>()
const factListeners = new Set<(preparationId: string) => void>()

/** Observes every recorded change to a preparation's runner outcome or takeover evidence. */
export function onPreparationFactsChanged(listener: (preparationId: string) => void): () => void {
  factListeners.add(listener)
  return () => {
    factListeners.delete(listener)
  }
}

function notifyFactsChanged(preparationId: string): void {
  for (const listener of factListeners) {
    try {
      listener(preparationId)
    } catch (error) {
      console.error('[preparation] facts listener failed:', error)
    }
  }
}

function emptyFacts(): Facts {
  return { outcome: null, takeover: null }
}

function factsFor(preparationId: string): Facts {
  const current = facts.get(preparationId)
  if (current) {
    return current
  }
  const created = emptyFacts()
  facts.set(preparationId, created)
  return created
}

export function resetPreparationObservationsForTests(): void {
  agents.clear()
  facts.clear()
  scanners.clear()
}

export function registerPreparationAgent(match: PreparationAgentMatch): void {
  const previous = agents.get(match.preparationId)
  if (previous && previous.incarnationId !== match.incarnationId) {
    factsFor(match.preparationId).takeover = null
    notifyFactsChanged(match.preparationId)
  }
  agents.set(match.preparationId, match)
}

export function preparationFacts(preparationId: string): Facts {
  return facts.get(preparationId) ?? emptyFacts()
}

export function preparationCleanupAuthorized(preparationId: string): boolean {
  const current = facts.get(preparationId)
  return current?.outcome?.status === 'succeeded' && current.takeover?.ready === true
}

function readinessReceipt(payload: Record<string, unknown>): {
  rootSessionId: string
  statusOwnerModule: string
} | null {
  const receipt = readPreparationRootReadiness(payload)
  return receipt
    ? { rootSessionId: receipt.root_session_id, statusOwnerModule: receipt.status_owner_module }
    : null
}

function registeredMatch(match: PreparationAgentMatch): PreparationAgentMatch | null {
  const registered = agents.get(match.preparationId)
  if (!registered) {
    return null
  }
  if (
    registered.paneKey !== match.paneKey ||
    registered.launchToken !== match.launchToken ||
    registered.incarnationId !== match.incarnationId ||
    registered.ptyId !== match.ptyId
  ) {
    return null
  }
  return registered
}

export function ingestAuthenticatedRootReadiness(input: {
  authenticated: boolean
  match: PreparationAgentMatch
  payload: Record<string, unknown>
}): void {
  const registered = registeredMatch(input.match)
  if (!registered) {
    return
  }
  const eventName = input.payload.hook_event_name
  if (eventName === 'tool_approval_requested') {
    factsFor(registered.preparationId).takeover = null
    notifyFactsChanged(registered.preparationId)
    return
  }
  if (!input.authenticated) {
    return
  }
  // Why: the extension coalesces status posts, so the readiness fact may ride any later snapshot.
  const receipt = readinessReceipt(input.payload)
  if (!receipt) {
    return
  }
  const current = factsFor(registered.preparationId).takeover
  if (
    current?.rootSessionId === receipt.rootSessionId &&
    current.incarnationId === registered.incarnationId
  ) {
    return
  }
  factsFor(registered.preparationId).takeover = {
    ready: true,
    rootSessionId: receipt.rootSessionId,
    statusOwnerModule: receipt.statusOwnerModule,
    paneKey: registered.paneKey,
    launchToken: registered.launchToken,
    incarnationId: registered.incarnationId
  }
  notifyFactsChanged(registered.preparationId)
}

export function observeAuthenticatedHookBody(body: unknown, authenticated: boolean): void {
  if (!isRecord(body)) {
    return
  }
  const { paneKey, payload } = body
  if (typeof paneKey !== 'string' || !isRecord(payload)) {
    return
  }
  const launchToken = typeof body.launchToken === 'string' ? body.launchToken : ''
  const agent = [...agents.values()].find(
    (candidate) => candidate.paneKey === paneKey && candidate.launchToken === launchToken
  )
  if (!agent) {
    return
  }
  ingestAuthenticatedRootReadiness({ authenticated, match: agent, payload })
}

/**
 * Observes a relay `agent.hook` envelope. The relay carries the raw receipt and hook event name
 * beside the normalized status payload, so they are folded back into one hook body here.
 */
export function observeAuthenticatedRelayEnvelope(envelope: {
  paneKey: string
  launchToken: string | undefined
  hookEventName: unknown
  rootReadiness: unknown
  payload: unknown
}): void {
  const { payload } = envelope
  if (!isRecord(payload)) {
    return
  }
  observeAuthenticatedHookBody(
    {
      paneKey: envelope.paneKey,
      launchToken: envelope.launchToken,
      payload: {
        ...payload,
        ...(typeof envelope.hookEventName === 'string' && !('hook_event_name' in payload)
          ? { hook_event_name: envelope.hookEventName }
          : {}),
        ...readPreparationRootReadiness(envelope.rootReadiness)
      }
    },
    true
  )
}

export function invalidatePreparationLiveness(ptyId: string, exitIncarnationId?: string): void {
  for (const [preparationId, agent] of agents) {
    if (agent.ptyId !== ptyId) {
      continue
    }
    if (exitIncarnationId && exitIncarnationId !== agent.incarnationId) {
      continue
    }
    // Why: an exited incarnation is no longer a live agent; a delayed or replayed receipt must not match it.
    agents.delete(preparationId)
    factsFor(preparationId).takeover = null
    notifyFactsChanged(preparationId)
  }
  scanners.delete(ptyId)
}

export function armPreparationRunnerObservation(
  preparationId: string,
  ptyId: string,
  token: string
): void {
  scanners.set(
    ptyId,
    createSetupCompletionScanner(token, (exitCode) => {
      factsFor(preparationId).outcome = {
        status: exitCode === 0 ? 'succeeded' : 'failed',
        token
      }
      notifyFactsChanged(preparationId)
    })
  )
}

export function feedPreparationRunnerObservation(ptyId: string, data: string): void {
  scanners.get(ptyId)?.scan(data)
}
