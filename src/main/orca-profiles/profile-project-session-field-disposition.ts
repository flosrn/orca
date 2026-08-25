import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** What `removeRepoFromWorkspaceSession` does with a field when its repo goes away. */
export type SessionFieldRepoRemovalDisposition =
  /** Owner-keyed map: the shared helper deletes every key belonging to the repo. */
  | 'prunedByOwnerKey'
  /** Pruned too, but by a rule of its own -- derived ids, pane keys, or a scalar. */
  | 'prunedByBespokeRule'
  /** Holds nothing repo-scoped, so removal leaves it alone. */
  | 'notRepoScoped'

/** What `extractSessionForTransfer` does with a field when its repo moves to another profile. */
export type SessionFieldTransferDisposition =
  /** Owner-keyed map: keys are rekeyed onto the new repo id and the values cloned as-is. */
  | 'copiedByOwnerKey'
  /** Copied too, but with element-level rekeying or an id filter of its own. */
  | 'copiedByBespokeRule'
  /** Deliberately left behind: it names something only the source profile can resolve. */
  | 'notTransferred'

type SessionFieldDisposition = {
  onRepoRemoval: SessionFieldRepoRemovalDisposition
  onTransfer: SessionFieldTransferDisposition
}

/**
 * Every persisted session field, and what the repo-removal and project-transfer paths owe it.
 *
 * Why this exists: `clientHostedBrowserPagesByWorktree` was added to the session type and then
 * missed by three separate prune paths, because nothing made handling it mandatory. Classification
 * is now a compile error to skip, and the two owner-keyed lists below are what those paths
 * actually iterate -- so a field marked `prunedByOwnerKey` is pruned by construction.
 */
export const WORKSPACE_SESSION_FIELD_DISPOSITION = {
  activeRepoId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  activeWorkspaceKey: { onRepoRemoval: 'prunedByBespokeRule', onTransfer: 'copiedByBespokeRule' },
  activeWorkspaceExecutionHostId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  activeWorktreeId: { onRepoRemoval: 'prunedByBespokeRule', onTransfer: 'copiedByBespokeRule' },
  activeTabId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  tabsByWorktree: { onRepoRemoval: 'prunedByBespokeRule', onTransfer: 'copiedByBespokeRule' },
  // Keyed by tab id, so both paths follow the tab ids the terminal maps gave up or carried over.
  terminalLayoutsByTabId: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  activeWorktreeIdsOnShutdown: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  openFilesByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByBespokeRule' },
  activeFileIdByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  markdownFrontmatterVisible: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  browserTabsByWorktree: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  // Keyed by browser workspace id, so both paths follow the workspaces the map above resolved.
  browserPagesByWorkspace: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  activeBrowserTabIdByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey'
  },
  // Why not transferred: each row names a paired device and a browser profile that only the source
  // profile can resolve, and the payload carries neither -- the same reason a transferred browser
  // workspace gives up its sessionProfileId. A copied row would restore as a held tab no device can
  // ever reclaim, which is exactly the stuck "unavailable" state persistence exists to prevent.
  clientHostedBrowserPagesByWorktree: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'notTransferred'
  },
  // Keyed by runtime environment, not by worktree: this client's debt to environments that outlive
  // any one repo.
  clientHostedBrowserCloseIntentsByEnvironment: {
    onRepoRemoval: 'notRepoScoped',
    onTransfer: 'notTransferred'
  },
  activeTabTypeByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  browserUrlHistory: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  activeTabIdByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  unifiedTabs: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByBespokeRule' },
  tabGroups: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByBespokeRule' },
  tabGroupLayouts: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  activeGroupIdByWorktree: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  activeConnectionIdsAtShutdown: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  remoteSessionIdsByTabId: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  lastVisitedAtByWorktreeId: { onRepoRemoval: 'prunedByOwnerKey', onTransfer: 'copiedByOwnerKey' },
  defaultTerminalTabsAppliedByWorktreeId: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey'
  },
  sleepingAgentSessionsByPaneKey: { onRepoRemoval: 'notRepoScoped', onTransfer: 'notTransferred' },
  terminalPtyIncarnationsByPaneKey: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  },
  // Repo-keyed rather than worktree-keyed, but the owner-key helpers already treat a bare repo id
  // as its own owner key.
  terminalTopologyRevisionByRepoId: {
    onRepoRemoval: 'prunedByOwnerKey',
    onTransfer: 'copiedByOwnerKey'
  },
  terminalSurfaceTombstonesByPaneKey: {
    onRepoRemoval: 'prunedByBespokeRule',
    onTransfer: 'copiedByBespokeRule'
  }
} as const satisfies Record<keyof WorkspaceSessionState, SessionFieldDisposition>

// Why: an unclassified field is a field both paths forget, and the leak only surfaces as state
// belonging to a project that is no longer here.
type UnclassifiedSessionField = Exclude<
  keyof WorkspaceSessionState,
  keyof typeof WORKSPACE_SESSION_FIELD_DISPOSITION
>
const exhaustive: [UnclassifiedSessionField] extends [never] ? true : never = true
void exhaustive

const SESSION_FIELDS = Object.keys(
  WORKSPACE_SESSION_FIELD_DISPOSITION
) as (keyof WorkspaceSessionState)[]

export const SESSION_FIELDS_PRUNED_BY_OWNER_KEY = SESSION_FIELDS.filter(
  (field) => WORKSPACE_SESSION_FIELD_DISPOSITION[field].onRepoRemoval === 'prunedByOwnerKey'
)

export const SESSION_FIELDS_COPIED_BY_OWNER_KEY = SESSION_FIELDS.filter(
  (field) => WORKSPACE_SESSION_FIELD_DISPOSITION[field].onTransfer === 'copiedByOwnerKey'
)
