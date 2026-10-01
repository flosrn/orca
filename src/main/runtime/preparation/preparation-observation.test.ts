import type { WorkerSetupReceipt } from '../rpc/methods/orchestration/worker/worker-topology'
import { beforeEach, describe, expect, it } from 'vitest'

import { applyWaitForSetupOutcome } from '../rpc/methods/orchestration/worker/worker-topology'
import {
  ingestAuthenticatedRootReadiness,
  preparationCleanupAuthorized,
  preparationFacts,
  registerPreparationAgent,
  resetPreparationObservationsForTests
} from './preparation-observation'

const MATCH = {
  preparationId: 'prep-1',
  paneKey: 'pane-1',
  launchToken: 'launch-1',
  incarnationId: 'inc-1',
  ptyId: 'pty-agent'
}

const RECEIPT = {
  root_session_ready: true,
  root_session_id: 'root-session-1',
  status_owner_module: '/opt/orca/extensions/orca-agent-status.ts'
}

describe('preparation observation', () => {
  beforeEach(() => {
    resetPreparationObservationsForTests()
    registerPreparationAgent(MATCH)
  })
  it('persists runner success and root takeover as separate facts', () => {
    ingestAuthenticatedRootReadiness({
      authenticated: true,
      match: MATCH,
      payload: { hook_event_name: 'session_start', ...RECEIPT }
    })
    expect(preparationFacts('prep-1')).toEqual({
      outcome: null,
      takeover: {
        ready: true,
        rootSessionId: 'root-session-1',
        statusOwnerModule: '/opt/orca/extensions/orca-agent-status.ts',
        paneKey: 'pane-1',
        launchToken: 'launch-1',
        incarnationId: 'inc-1'
      }
    })
    expect(preparationCleanupAuthorized('prep-1')).toBe(false)
  })

  it('does not bind a readiness receipt whose pane, launch, or incarnation misses the agent record', () => {
    for (const mismatch of [
      { paneKey: 'other-pane' },
      { launchToken: 'other-launch' },
      { incarnationId: 'other-incarnation' }
    ]) {
      ingestAuthenticatedRootReadiness({
        authenticated: true,
        match: { ...MATCH, ...mismatch },
        payload: { hook_event_name: 'session_start', ...RECEIPT }
      })
    }
    expect(preparationFacts('prep-1').takeover).toBeNull()
  })

  it('drops an unauthenticated or partial readiness payload before it can become takeover', () => {
    ingestAuthenticatedRootReadiness({
      authenticated: false,
      match: MATCH,
      payload: { hook_event_name: 'session_start', ...RECEIPT }
    })
    ingestAuthenticatedRootReadiness({
      authenticated: true,
      match: MATCH,
      payload: { hook_event_name: 'session_start', root_session_ready: true }
    })
    expect(preparationFacts('prep-1').takeover).toBeNull()
  })

  it('invalidates takeover when approval is blocked, the pane is not live, or the incarnation is replaced', () => {
    ingestAuthenticatedRootReadiness({
      authenticated: true,
      match: MATCH,
      payload: { hook_event_name: 'session_start', ...RECEIPT }
    })
    ingestAuthenticatedRootReadiness({
      authenticated: true,
      match: MATCH,
      payload: { hook_event_name: 'tool_approval_requested', ...RECEIPT }
    })
    expect(preparationCleanupAuthorized('prep-1')).toBe(false)
    expect(preparationFacts('prep-1').takeover).toBeNull()
  })

  it('does not treat an orchestration setup receipt as cleanup authority', () => {
    const receipt: WorkerSetupReceipt = {
      requested: 'run',
      effective: 'run',
      source: 'repo',
      hookFound: true,
      startupPolicy: 'wait-for-setup',
      state: 'running'
    }
    applyWaitForSetupOutcome(receipt, [], { satisfied: true, status: 'exited' })
    expect(receipt.state).toBe('succeeded')
    expect(preparationCleanupAuthorized('prep-1')).toBe(false)
  })
})
