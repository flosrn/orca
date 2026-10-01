import { installRuntimeLinearCommandSurface } from './runtime-linear-command-surface'
import { OrcaRuntimeWithPreparationRetirement } from './orca-runtime-preparation-retirement'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import { registerWorktreeChangeInvalidator } from '../ipc/worktree-change-invalidators'
import { registerDetectedWorktreeScanInvalidation } from '../ipc/worktrees/listing/register-detected-worktree-scan-invalidation'
import { PreparationOutputRuntime } from './preparation/preparation-output-runtime'
import type { PreparationOutputStore } from './preparation/preparation-output-store'
import type { PreparationArchiveCommit } from './preparation/preparation-output-contracts'
import type { PreparationRecoveryDecision } from './preparation/preparation-recovery'

class OrcaRuntimeService extends OrcaRuntimeWithPreparationRetirement {
  // Why a field here: onPtyData/onPtySpawned/onPtyExit in the split chain forward to it.
  protected readonly preparationOutput: PreparationOutputRuntime

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithPreparationRetirement>) {
    super(...args)
    this.preparationOutput = new PreparationOutputRuntime({ records: this.preparationRecords })
    this.installPreparationRetirement(this.preparationOutput)
    // Why: the runtime listing re-runs a scan the worktree-change generation overtook and re-lists
    // through this runtime's scan cache, so a worktree change must reach both. The desktop IPC
    // module registers the generation bump at load; a headless host never loads it.
    registerDetectedWorktreeScanInvalidation()
    registerWorktreeChangeInvalidator((repoId) => this.invalidateWorktreeCatalog(repoId))
  }

  /**
   * Opens preparation archives and lifecycle facts under private profile storage. Hosts call it
   * before PTY replay so restored output reaches its recorded preparation, never a replacement.
   */
  setPreparationStorage(options: { directory: string }): void {
    this.preparationOutput.configureStorage(options)
  }

  /** Null until storage is configured; readers treat that as unavailable, not empty. */
  getPreparationOutputStore(): PreparationOutputStore | null {
    return this.preparationOutput.outputStore()
  }

  commitPreparationOutput(args: {
    preparationId: string
    inputRevision: number
  }): PreparationArchiveCommit {
    return this.preparationOutput.commit(args)
  }

  /**
   * Restart reconciliation, run once provider inventory is available: each recorded pane no live
   * incarnation re-announced is read back through its owning provider. Only a provider-certified
   * absence is an exit; a live pane counts only with the incarnation this runtime observed, and
   * anything else is unverifiable and changes nothing.
   */
  recoverPreparationLifecycle(): Promise<PreparationRecoveryDecision[]> {
    return this.preparationOutput.recover(async (pane) => {
      let alive: boolean | null = null
      try {
        alive = (await this.ptyController?.probePtyLiveness?.(pane.ptyId)) ?? null
      } catch {
        alive = null
      }
      if (alive === false) {
        return { status: 'exited' }
      }
      const pty = this.ptysById.get(pane.ptyId)
      return alive === true && pty?.connected && pty.incarnationId
        ? { status: 'live', incarnationId: pty.incarnationId }
        : { status: 'unverifiable' }
    })
  }

  /** Retired preparations never enqueue their setup command again. */
  override mayEnqueuePreparationSetup(preparationId: string): boolean {
    return this.preparationOutput.mayEnqueueSetup(preparationId)
  }
}
type OrcaRuntimeServiceExport = RuntimeCommandSurfaceHost<OrcaRuntimeService>
const OrcaRuntimeServiceExport = OrcaRuntimeService as unknown as {
  new (...args: ConstructorParameters<typeof OrcaRuntimeService>): OrcaRuntimeServiceExport
  readonly prototype: OrcaRuntimeServiceExport
}
export { OrcaRuntimeServiceExport as OrcaRuntimeService }
installRuntimeLinearCommandSurface(OrcaRuntimeServiceExport.prototype)

export type { LegacyWorkerTerminalRecoveryResult } from './runtime-legacy-worker-terminal-recovery-types'
export type {
  RuntimeAutomationCreateInput,
  RuntimeAutomationUpdateInput
} from './runtime-automation-controller'
export type { SubscriptionRegistration } from './runtime-subscription-registry'
export type {
  OrchestrationCompatibilityCallerAuthority,
  OrchestrationCompatibilityTerminalAuthority,
  RuntimePtyDataAdmission,
  RuntimeTerminalAgentStatusEvent
} from './runtime-terminal-contracts'
export type { MessageWaitResult } from './runtime-message-waiters'
export type { AccountsSnapshot, CodexRateLimitResetRpcResult } from './runtime-account-controller'
export type {
  MobileNotificationDispatchEvent,
  MobileNotificationDismissEvent,
  MobileNotificationEvent
} from './runtime-mobile-notification-controller'
export type { RuntimeTerminalDataMeta } from './runtime-terminal-stream-consumers'
export type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'
export {
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason,
  type TerminalTailWaitState
} from './terminal-wait-tail-state'
export { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
export { appendNormalizedToMultilineTailBufferUnwindowed } from './terminal-tail-redraw-buffer'
export { buildPreview } from './terminal-tail-state'
export { buildRestoredTerminalTailSeed } from './terminal-tail-restore-seed'
export { projectTerminalTailLines } from './orca-runtime-terminal-projection'
export { resolveWorktreeScanCacheTtlMs } from './runtime-worktree-scan-cache'
export type {
  RuntimeWorktreeLifecycleEvent,
  DriverState,
  PtyLayoutTarget,
  PtyLayoutState,
  ApplyLayoutResult,
  RuntimeRendererReloadFence
} from './orca-runtime-core'
export {
  AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
  WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS,
  WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS
} from './orca-runtime-postlude'
