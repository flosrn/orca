import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { PtyIdleRetirementResult } from '../../shared/pty-idle-retirement'
import type { PreparationOutputRuntime } from './preparation/preparation-output-runtime'
import {
  onPreparationFactsChanged,
  preparationCleanupAuthorized
} from './preparation/preparation-observation'
import {
  PreparationRetirementRuntime,
  retainUnsupportedRetirement
} from './preparation/preparation-retirement-runtime'
import type {
  PreparationRetiredLeaf,
  PreparationRetirementVerdict
} from './preparation/preparation-retirement'

/**
 * Wires automatic preparation retirement into the managing runtime: facts come from the
 * runtime's own PTY records, the controller's input revision and canonical persisted layout;
 * removal goes through the same durable surface retirement the exit path uses.
 */
export class OrcaRuntimeWithPreparationRetirement extends OrcaRuntimeWithResolveWaiter {
  protected preparationRetirement: PreparationRetirementRuntime | null = null

  protected installPreparationRetirement(output: PreparationOutputRuntime): void {
    const retirement = new PreparationRetirementRuntime({
      record: (preparationId) => this.preparationRecords.get(preparationId),
      recordForPty: (ptyId) => {
        const found = this.preparationRecords.findByPtyId(ptyId)
        return found?.role === 'preparation' ? found.record : null
      },
      cleanupAuthorized: preparationCleanupAuthorized,
      lifecycle: () => output.lifecycle(),
      commitOutput: (args) => output.commit(args),
      livePty: (ptyId) => {
        const pty = this.ptysById.get(ptyId)
        if (!pty?.connected || !pty.incarnationId) {
          return null
        }
        return {
          incarnationId: pty.incarnationId,
          tabId: pty.tabId,
          paneKey: pty.paneKey,
          outputSequence: this.ptyOutputSequenceById.get(ptyId) ?? 0
        }
      },
      inputRevision: (ptyId) => this.ptyController?.inputRevision?.(ptyId) ?? null,
      layoutSignature: (ptyId, tabId, leafId) =>
        this.preparationLeafLayoutSignature(ptyId, tabId, leafId),
      retireIdle: (ptyId, request): Promise<PtyIdleRetirementResult> =>
        this.ptyController?.retireIdle
          ? this.ptyController.retireIdle(ptyId, request)
          : retainUnsupportedRetirement(),
      setStopRequested: (ptyId, requested) => {
        if (requested) {
          this.markPtyStopRequested(ptyId)
        } else {
          this.stopRequestedPtyIds.delete(ptyId)
        }
      },
      removeLeaf: (leaf) => this.removeRetiredPreparationLeaf(leaf)
    })
    this.preparationRetirement = retirement
    // Why deferred: a runner marker is observed inside onPtyData before the chunk reaches the
    // capture, so evaluating synchronously would snapshot output without the marker line.
    const schedule = (preparationId: string): void => {
      queueMicrotask(() => retirement.factsChanged(preparationId))
    }
    onPreparationFactsChanged(schedule)
    this.preparationRecords.onChange((event) => {
      if (event.kind === 'bound') {
        schedule(event.record.preparationId)
      }
    })
  }

  /** Explicit evaluation for callers that already know a fact changed; never forces a stop. */
  evaluatePreparationRetirement(preparationId: string): Promise<PreparationRetirementVerdict> {
    return (
      this.preparationRetirement?.evaluate(preparationId) ??
      Promise.resolve({ outcome: 'retained', blockers: ['unregistered'] })
    )
  }

  override onPtyData(...args: Parameters<OrcaRuntimeWithResolveWaiter['onPtyData']>): number {
    // Why first: quiescence measures from this chunk even when it completes the runner.
    this.preparationRetirement?.noteOutput(args[0])
    return super.onPtyData(...args)
  }

  override onPtyExit(
    ...args: Parameters<OrcaRuntimeWithResolveWaiter['onPtyExit']>
  ): ReturnType<OrcaRuntimeWithResolveWaiter['onPtyExit']> {
    const [ptyId, , exitIncarnationId] = args
    // An exit without an incarnation is the current one's (isCurrentPtyExit); read it first.
    const incarnationId = exitIncarnationId ?? this.ptysById.get(ptyId)?.incarnationId ?? undefined
    const result = super.onPtyExit(...args)
    this.preparationRetirement?.noteExit(ptyId, incarnationId)
    this.preparationRetirement?.forgetPty(ptyId)
    return result
  }

  /** Leaf membership only: focus, zoom and sizing changes are not layout changes for retirement. */
  private preparationLeafLayoutSignature(ptyId: string, tabId: string, leafId: string): string {
    const worktreeId = this.ptysById.get(ptyId)?.worktreeId
    const hostId = worktreeId
      ? (this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId) ?? LOCAL_EXECUTION_HOST_ID)
      : LOCAL_EXECUTION_HOST_ID
    const session = this.store?.getWorkspaceSession?.(hostId)
    const layout = session?.terminalLayoutsByTabId?.[tabId]
    const persistedTab = worktreeId
      ? session?.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId)
      : false
    const graph = this.getLeavesForPty(ptyId)
      .map((leaf) => `${leaf.tabId}:${leaf.leafId}`)
      .sort()
    return JSON.stringify([
      persistedTab ?? false,
      layout?.ptyIdsByLeafId?.[leafId] ?? null,
      session?.terminalPtyIncarnationsByPaneKey?.[`${tabId}:${leafId}`] ?? null,
      graph
    ])
  }

  private async removeRetiredPreparationLeaf(leaf: PreparationRetiredLeaf): Promise<boolean> {
    const worktreeId = this.ptysById.get(leaf.ptyId)?.worktreeId
    if (!worktreeId) {
      return false
    }
    const surface = {
      worktreeId,
      parentTabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      incarnationId: leaf.incarnationId
    }
    const persisted = await this.persistTerminalSurfaceRetirements([surface])
    if (!persisted) {
      return false
    }
    // Runtime inventory and paired snapshots: same publication as a permanent exit, exact leaf only.
    await this.retireMobileSessionSurfacesForPty(leaf.ptyId, leaf.incarnationId, [
      { worktreeId, parentTabId: leaf.tabId, leafId: leaf.leafId }
    ])
    // Desktop renderer mirrors the exact leaf for mounted and hidden tabs alike; never a tab close.
    this.notifier?.retireTerminalSurface?.({
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId
    })
    return true
  }
}
