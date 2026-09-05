// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithSerializeHeadlessTerminalBuffer } from './orca-runtime-serialize-headless-terminal-buffer'
import type {
  OrchestrationCompatibilityEvidence,
  OrchestrationCompatibilityHostStamp
} from '../../shared/orchestration-compatibility-evidence'
import type {
  OrchestrationCompatibilityCallerAuthority,
  OrchestrationCompatibilityTerminalAuthority
} from './runtime-terminal-contracts'
import { createHash } from 'node:crypto'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'

export class OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller extends OrcaRuntimeWithSerializeHeadlessTerminalBuffer {
  verifyOrchestrationCompatibilityCaller(
    evidence: OrchestrationCompatibilityEvidence | null | undefined,
    options?: { currentRuntimeLaunchSufficient?: boolean }
  ): OrchestrationCompatibilityCallerAuthority | null {
    const terminalHandle =
      typeof evidence?.terminalHandle === 'string' ? evidence.terminalHandle.trim() : ''
    const claimedPaneKey = typeof evidence?.paneKey === 'string' ? evidence.paneKey.trim() : ''
    const launchToken = typeof evidence?.launchToken === 'string' ? evidence.launchToken.trim() : ''
    const host = evidence?.host
    if (!terminalHandle || !claimedPaneKey || !launchToken) {
      return null
    }
    const terminal = this.getOrchestrationDispatchAuthority(terminalHandle)
    if (
      !terminal?.processIncarnation ||
      !terminal.paneKey ||
      !this.orchestrationCompatibilityHostMatches(terminal.hostScope, host)
    ) {
      return null
    }
    const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
    let terminalProvenance: 'current_runtime' | 'restored'
    if (terminal.launchTokenHash) {
      if (launchTokenHash !== terminal.launchTokenHash) {
        return null
      }
      terminalProvenance = 'current_runtime'
    } else {
      const receipt = this.restoredOrchestrationAuthorityByPtyId.get(terminal.ptyId)
      if (
        !receipt ||
        receipt.ptyId !== terminal.ptyId ||
        receipt.worktreeId !== terminal.worktreeId ||
        receipt.terminalHandle !== terminal.terminalHandle ||
        receipt.paneKey !== terminal.paneKey ||
        receipt.processIncarnation !== terminal.processIncarnation ||
        !this.orchestrationCompatibilityHostScopesEqual(receipt.hostScope, terminal.hostScope)
      ) {
        return null
      }
      terminalProvenance = 'restored'
    }
    if (
      options?.currentRuntimeLaunchSufficient &&
      terminalProvenance === 'current_runtime' &&
      claimedPaneKey === terminal.paneKey
    ) {
      // Why: the checks above bind a fresh launch to its live PTY, host, and
      // launch secret. Only an exact live-pane match may skip hook attestation.
      return this.freezeOrchestrationCompatibilityCallerAuthority(
        terminal,
        terminal.processIncarnation,
        claimedPaneKey,
        terminalHandle,
        launchTokenHash
      )
    }
    const attestation = this.attestAgentHookCompatibilityAuthorityFn?.({
      paneKey: claimedPaneKey,
      launchTokenHash,
      connectionId: terminal.hostScope.kind === 'ssh' ? terminal.hostScope.targetId : null,
      terminalProvenance
    })
    if (!attestation || attestation.paneKey !== terminal.paneKey) {
      return null
    }
    return this.freezeOrchestrationCompatibilityCallerAuthority(
      terminal,
      terminal.processIncarnation,
      attestation.paneKey,
      terminalHandle,
      launchTokenHash
    )
  }

  protected freezeOrchestrationCompatibilityCallerAuthority(
    terminal: OrchestrationCompatibilityTerminalAuthority,
    processIncarnation: string,
    paneKey: string,
    terminalHandle: string,
    launchTokenHash: string
  ): OrchestrationCompatibilityCallerAuthority {
    return Object.freeze({
      hostScope: Object.freeze({ ...terminal.hostScope }),
      paneKey,
      terminalHandle,
      processIncarnation,
      launchTokenHash
    })
  }

  protected orchestrationCompatibilityHostMatches(
    hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope'],
    host: OrchestrationCompatibilityHostStamp | undefined
  ): boolean {
    if (hostScope.kind === 'local') {
      return host === undefined
    }
    if (hostScope.kind === 'wsl') {
      return (
        host?.kind === 'wsl' && host.hostId === hostScope.hostId && host.distro === hostScope.distro
      )
    }
    if (host?.kind !== 'ssh' || host.targetId !== hostScope.targetId) {
      return false
    }
    const authority = this.orchestrationCompatibilitySshAttachments.get(host.attachmentId)
    return (
      authority?.targetId === host.targetId &&
      authority.connectionIncarnation === host.connectionIncarnation
    )
  }

  protected orchestrationCompatibilityHostScopesEqual(
    left: OrchestrationCompatibilityTerminalAuthority['hostScope'],
    right: OrchestrationCompatibilityTerminalAuthority['hostScope']
  ): boolean {
    if (left.kind !== right.kind) {
      return false
    }
    if (left.kind === 'local' && right.kind === 'local') {
      return left.hostId === right.hostId
    }
    if (left.kind === 'wsl' && right.kind === 'wsl') {
      return left.hostId === right.hostId && left.distro === right.distro
    }
    return left.kind === 'ssh' && right.kind === 'ssh' && left.targetId === right.targetId
  }

  protected getOrchestrationCompatibilityHostScope(
    pty: RuntimePtyWorktreeRecord
  ): OrchestrationCompatibilityTerminalAuthority['hostScope'] | null {
    if (pty.connectionId) {
      return { kind: 'ssh', targetId: pty.connectionId }
    }
    if (pty.isWsl || pty.wslDistro) {
      return pty.wslDistro ? { kind: 'wsl', hostId: 'local', distro: pty.wslDistro } : null
    }
    return { kind: 'local', hostId: 'local' }
  }

  protected rememberRestoredOrchestrationAuthority(
    pty: RuntimePtyWorktreeRecord,
    terminalHandle: string,
    incarnationId: string
  ): void {
    const paneKey = pty.paneKey
    const hostScope = this.getOrchestrationCompatibilityHostScope(pty)
    if (!paneKey || !parsePaneKey(paneKey) || !hostScope) {
      this.restoredOrchestrationAuthorityByPtyId.delete(pty.ptyId)
      return
    }
    this.restoredOrchestrationAuthorityByPtyId.set(
      pty.ptyId,
      Object.freeze({
        ptyId: pty.ptyId,
        worktreeId: pty.worktreeId,
        terminalHandle,
        paneKey,
        processIncarnation: `${pty.ptyId}:${incarnationId}`,
        hostScope: Object.freeze({ ...hostScope })
      })
    )
  }

  // Why: measured 2026-09-04 (flosrn/ax#160, dispatch ctx_66bcf1795f09). The daemon
  // outlived an Orca quit/relaunch, so the worker agent kept running with its
  // original ORCA_TERMINAL_HANDLE, but nothing re-materialized its pane: the
  // persisted surface binding could not restore `pty.paneKey`, so
  // getOrchestrationDispatchAuthority produced no pane, no attestation could be
  // verified, and the agent's worker_done was refused "The caller is not the
  // Dispatch pane." The Dispatch row is the second record of that pane identity,
  // and the live PTY's controller identity — the env-baked handle plus the
  // daemon-assigned incarnation, both re-observed from the inventory — proves the
  // row is this very process. Restoring the pane from it re-binds identity; it
  // grants no authority on its own, since the caller must still pass launch-token
  // and hook attestation against that pane.
  protected restoreReadoptedWorkerPaneIdentity(
    pty: RuntimePtyWorktreeRecord,
    identity: { handle: string; incarnationId: string }
  ): boolean {
    if (pty.paneKey || !pty.worktreeId) {
      return false
    }
    const surface = this.getOrchestrationDbIfAvailable()?.getReadoptedWorkerDispatchSurface?.({
      terminalHandle: identity.handle,
      processIncarnation: `${pty.ptyId}:${identity.incarnationId}`
    })
    const pane = surface ? parsePaneKey(surface.paneKey) : null
    if (!surface || !pane || !runtimeWorktreeIdsEqual(surface.worktreeId, pty.worktreeId)) {
      return false
    }
    pty.tabId = pane.tabId
    pty.paneKey = surface.paneKey
    this.rememberRestoredOrchestrationAuthority(pty, identity.handle, identity.incarnationId)
    return true
  }
}
