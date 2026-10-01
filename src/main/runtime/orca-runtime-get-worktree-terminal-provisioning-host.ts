// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithActivateManagedWorktree } from './orca-runtime-activate-managed-worktree'
import type {
  WorktreeProvisionTerminalOptions,
  WorktreeTerminalProvisioningHost
} from './runtime-worktree-terminal-provisioning'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { WorktreeStartupReadinessHost } from './runtime-worktree-startup-readiness'
import { prefetchWorktreeCreateBase } from '../worktree-create-base-prefetch'
import { prepareWorktreeCreateForRepo } from '../worktree-create-preparation'
import { getWorktreeCreatePrefetchGitOptions } from '../project-runtime-git-options'
import { createWorktreeIdentity } from '../../shared/worktree/identity'
import type { Worktree } from '../../shared/worktree/types'
import {
  armPreparationRunnerObservation,
  feedPreparationRunnerObservation
} from './preparation/preparation-observation'
import type { WorktreeSetupLaunch } from '../../shared/worktree/launch-types'
import type {
  PreparationPaneBinding,
  PreparationRecord,
  PreparationRecordFilter,
  PreparationSpawnIntake
} from '../../shared/preparation-contracts'
import type { PreparationPaneReservation } from './preparation/preparation-record-store'

export class OrcaRuntimeWithGetWorktreeTerminalProvisioningHost extends OrcaRuntimeWithActivateManagedWorktree {
  listPreparationRecords(filter?: PreparationRecordFilter): PreparationRecord[] {
    return this.preparationRecords.list(filter)
  }

  /**
   * Registers the finite preparation of a newly created worktree before anything can run it.
   * Rows without a canonical host + instance identity stay unowned rather than keyed by path.
   */
  registerWorktreePreparation<T extends WorktreeSetupLaunch>(
    worktree: Pick<Worktree, 'id' | 'hostId' | 'instanceId'>,
    setup: T | undefined
  ): T | undefined {
    if (!setup || !worktree.hostId || !worktree.instanceId) {
      return setup
    }
    const identity = createWorktreeIdentity({
      worktreeId: worktree.id,
      executionHostId: worktree.hostId,
      instanceId: worktree.instanceId
    })
    return { ...setup, preparation: this.preparationRecords.register(identity, worktree.id) }
  }

  /** Pre-spawn claim for spawns that do not go through createTerminal/splitTerminal (renderer panes). */
  reservePreparationPane(
    intake: PreparationSpawnIntake,
    worktreeId: string,
    reservation: PreparationPaneReservation
  ): boolean {
    return this.preparationRecords.reserve(intake, worktreeId, reservation)
  }

  bindPreparationPane(
    intake: PreparationSpawnIntake,
    worktreeId: string,
    binding: PreparationPaneBinding
  ): boolean {
    return this.preparationRecords.bind(intake, worktreeId, binding)
  }

  releasePreparationPane(intake: PreparationSpawnIntake, handle: string): void {
    this.preparationRecords.releaseReservation(intake, handle)
  }

  protected getWorktreeTerminalProvisioningHost(): WorktreeTerminalProvisioningHost {
    return {
      canSpawn: () => Boolean(this.ptyController?.spawn),
      createTerminal: (selector, options) =>
        this.createTerminal(selector, options as TerminalCreateOptions),
      splitTerminal: (handle, options) =>
        this.splitTerminal(handle, options as WorktreeProvisionTerminalOptions),
      setTabColor: async (worktreeId, tabId, color) => {
        await this.setMobileSessionTabProps(`id:${worktreeId}`, { tabId, color })
      },
      getSettings: () => this.requireStore().getSettings(),
      getPtyId: (handle) => this.getLivePtyForHandle(handle)?.pty.ptyId,
      recordSetupCompletionToken: (ptyId, token) => {
        this.setupCompletionTokenByPtyId.set(ptyId, token)
        const record = this.preparationRecords
          .list()
          .find((entry) => entry.preparation?.ptyId === ptyId)
        if (record) {
          armPreparationRunnerObservation(record.preparationId, ptyId, token)
          // Why: a fast runner can print its marker before the spawn reply arms the scanner.
          const early = this.recentPtyOutputById.get(ptyId)?.read()
          if (early) {
            feedPreparationRunnerObservation(ptyId, early)
          }
        }
      }
    }
  }

  protected getWorktreeStartupReadinessHost(): WorktreeStartupReadinessHost {
    return {
      getPtyId: (handle) => this.getLivePtyForHandle(handle)?.pty.ptyId ?? null,
      getForegroundProcess: (ptyId) => this.ptyController!.getForegroundProcess(ptyId),
      hasChildProcesses: (ptyId) =>
        this.ptyController!.hasChildProcesses?.(ptyId) ?? Promise.resolve(false),
      subscribeToData: (ptyId, listener) => this.subscribeToTerminalData(ptyId, listener),
      readRecentOutput: (ptyId) => this.recentPtyOutputById.get(ptyId)?.read(),
      write: (ptyId, data) => this.ptyController?.write(ptyId, data)
    }
  }

  async prefetchManagedWorktreeCreateBase(args: {
    repoSelector: string
    baseBranch?: string
  }): Promise<void> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }

    const repo = await this.resolveRepoSelector(args.repoSelector)
    const store = this.requireStore()
    await prefetchWorktreeCreateBase({
      repo,
      baseBranch: args.baseBranch,
      runtime: this,
      gitOptions: getWorktreeCreatePrefetchGitOptions(store, repo),
      prepareCheckout: (base) => prepareWorktreeCreateForRepo(store, repo, base)
    })
  }
}
