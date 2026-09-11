import type {
  ClaudeLivePtyBindingEntry,
  LegacyPaneKeyAliasEntry
} from '../../../shared/persisted-state-types'
import type { MigrationUnsupportedPtyEntry } from '../../../shared/agent-status-types'
import { canRegisterPaneKeyAlias, isOpaqueRemintedPaneKey } from '../../../shared/pane-key-alias'
import {
  isTerminalLeafId,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../shared/stable-pane-id'
import { agentHookServer } from '../../agent-hooks/server'

export function legacyMigrationUnsupportedRowsToAliasEntries(
  entries: MigrationUnsupportedPtyEntry[]
): LegacyPaneKeyAliasEntry[] {
  const normalizedEntries = normalizeMigrationUnsupportedPtyEntries(entries).filter(
    (entry) => entry.tabId && entry.paneKey && parsePaneKey(entry.paneKey)
  )
  const entriesByTabId = new Map<string, MigrationUnsupportedPtyEntry | null>()
  for (const entry of normalizedEntries) {
    const tabId = entry.tabId
    if (!tabId) {
      continue
    }
    entriesByTabId.set(tabId, entriesByTabId.has(tabId) ? null : entry)
  }
  const aliasEntries: LegacyPaneKeyAliasEntry[] = []
  for (const [tabId, entry] of entriesByTabId) {
    if (!entry?.paneKey) {
      continue
    }
    // Why: pre-stable rows lack the old numeric key; only synthesize single-pane aliases when the row is unambiguous.
    for (const legacyPaneKey of [`${tabId}:0`, `${tabId}:1`]) {
      aliasEntries.push({
        ptyId: entry.ptyId,
        legacyPaneKey,
        stablePaneKey: entry.paneKey,
        updatedAt: entry.updatedAt
      })
    }
  }
  return aliasEntries
}

// Why: bounds a corrupt/bloated persisted list — the gate only needs the few Claude sessions a daemon can keep alive.
export const MAX_CLAUDE_LIVE_PTY_SESSION_IDS = 200

// Why: bound removed-SSH-target history so remove/re-add churn can't grow the file unbounded.
export const MAX_REMOVED_SSH_TARGET_TOMBSTONES = 50

export function normalizeClaudeLivePtySessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  // Why: scan newest-first so the cap keeps the most recent ids, matching addClaudeLivePtySessionId's eviction policy.
  const ids: string[] = []
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const entry = value[index]
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 512) {
      continue
    }
    if (!ids.includes(entry)) {
      ids.push(entry)
    }
    if (ids.length >= MAX_CLAUDE_LIVE_PTY_SESSION_IDS) {
      break
    }
  }
  return ids.toReversed()
}

/**
 * Which Claude account each persisted live session was launched under.
 *
 * Unparseable or unknown entries are dropped rather than guessed: the gate
 * reads a missing binding as "cannot be attributed", which protects the shared
 * credentials without falsely claiming an account.
 */
export function normalizeClaudeLivePtyBindings(value: unknown): ClaudeLivePtyBindingEntry[] {
  if (!Array.isArray(value)) {
    return []
  }
  const entries: ClaudeLivePtyBindingEntry[] = []
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const entry = value[index] as Partial<ClaudeLivePtyBindingEntry> | null
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.sessionId !== 'string' ||
      entry.sessionId.length === 0 ||
      entry.sessionId.length > 512 ||
      (entry.route !== 'account-dir' && entry.route !== 'wsl-dir' && entry.route !== 'shared-dir')
    ) {
      continue
    }
    if (entry.accountId !== undefined && typeof entry.accountId !== 'string') {
      continue
    }
    // Why: an account-dir row without an account names no surface at all. Drop
    // it so the gate reads that session as unattributed — conservative for the
    // shared credentials — instead of binding it to an empty account id.
    if (entry.route === 'account-dir' && !entry.accountId) {
      continue
    }
    if (entries.some((existing) => existing.sessionId === entry.sessionId)) {
      continue
    }
    entries.push({
      sessionId: entry.sessionId,
      route: entry.route,
      ...(entry.accountId === undefined ? {} : { accountId: entry.accountId })
    })
    if (entries.length >= MAX_CLAUDE_LIVE_PTY_SESSION_IDS) {
      break
    }
  }
  return entries.toReversed()
}

export function normalizeMigrationUnsupportedPtyEntries(
  value: unknown
): MigrationUnsupportedPtyEntry[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is MigrationUnsupportedPtyEntry => {
    if (!entry || typeof entry !== 'object') {
      return false
    }
    const candidate = entry as Partial<MigrationUnsupportedPtyEntry>
    return (
      typeof candidate.ptyId === 'string' &&
      candidate.ptyId.length > 0 &&
      (candidate.worktreeId === undefined || typeof candidate.worktreeId === 'string') &&
      (candidate.tabId === undefined || typeof candidate.tabId === 'string') &&
      (candidate.leafId === undefined || isTerminalLeafId(candidate.leafId)) &&
      (candidate.paneKey === undefined || typeof candidate.paneKey === 'string') &&
      candidate.reason === 'legacy-numeric-pane-key' &&
      (candidate.source === 'local' || candidate.source === 'ssh') &&
      Number.isFinite(candidate.updatedAt)
    )
  })
}

export function normalizeLegacyPaneKeyAliasEntries(value: unknown): LegacyPaneKeyAliasEntry[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is LegacyPaneKeyAliasEntry => {
    if (!entry || typeof entry !== 'object') {
      return false
    }
    const candidate = entry as Partial<LegacyPaneKeyAliasEntry>
    if (
      typeof candidate.ptyId !== 'string' ||
      candidate.ptyId.trim().length === 0 ||
      typeof candidate.legacyPaneKey !== 'string' ||
      typeof candidate.stablePaneKey !== 'string' ||
      !Number.isFinite(candidate.updatedAt)
    ) {
      return false
    }
    return (
      canRegisterPaneKeyAlias(candidate.legacyPaneKey, candidate.stablePaneKey) ||
      Boolean(parsePaneKey(candidate.legacyPaneKey) && parsePaneKey(candidate.stablePaneKey))
    )
  })
}

export function registerPersistedPaneKeyAlias(entry: LegacyPaneKeyAliasEntry): void {
  if (
    parseLegacyNumericPaneKey(entry.legacyPaneKey) ||
    isOpaqueRemintedPaneKey(entry.legacyPaneKey)
  ) {
    agentHookServer.registerPaneKeyAlias(
      entry.legacyPaneKey,
      entry.stablePaneKey,
      entry.ptyId,
      entry.updatedAt,
      { overwriteExisting: false }
    )
    return
  }
  // Why: detached agents keep their UUID pane key across restarts; restore the physical-to-owner mapping before hook replay.
  agentHookServer.transferPaneAuthority(
    entry.legacyPaneKey,
    entry.stablePaneKey,
    entry.ptyId,
    entry.updatedAt,
    { authorityVerified: false }
  )
}

export function mergeLegacyPaneKeyAliasEntries(
  entries: LegacyPaneKeyAliasEntry[]
): LegacyPaneKeyAliasEntry[] {
  const byLegacyPaneKey = new Map<string, LegacyPaneKeyAliasEntry>()
  for (const entry of normalizeLegacyPaneKeyAliasEntries(entries)) {
    const existing = byLegacyPaneKey.get(entry.legacyPaneKey)
    if (!existing || existing.updatedAt <= entry.updatedAt) {
      byLegacyPaneKey.set(entry.legacyPaneKey, entry)
    }
  }
  return [...byLegacyPaneKey.values()]
}

export function legacyPaneKeyAliasEntriesEqual(
  left: LegacyPaneKeyAliasEntry[],
  right: LegacyPaneKeyAliasEntry[]
): boolean {
  if (left.length !== right.length) {
    return false
  }
  const rightByLegacyPaneKey = new Map(right.map((entry) => [entry.legacyPaneKey, entry]))
  // Why: field-wise, not JSON.stringify — persisted key order differs from freshly built entries and would fake a dirty state.
  return left.every((entry) => {
    const other = rightByLegacyPaneKey.get(entry.legacyPaneKey)
    return (
      other !== undefined &&
      entry.ptyId === other.ptyId &&
      entry.stablePaneKey === other.stablePaneKey &&
      entry.updatedAt === other.updatedAt
    )
  })
}

export function migrationUnsupportedEntriesEqual(
  left: MigrationUnsupportedPtyEntry[],
  right: MigrationUnsupportedPtyEntry[]
): boolean {
  if (left.length !== right.length) {
    return false
  }
  const rightByPtyId = new Map(right.map((entry) => [entry.ptyId, entry]))
  return left.every((entry) => {
    const other = rightByPtyId.get(entry.ptyId)
    return (
      other !== undefined &&
      entry.worktreeId === other.worktreeId &&
      entry.tabId === other.tabId &&
      entry.leafId === other.leafId &&
      entry.paneKey === other.paneKey &&
      entry.reason === other.reason &&
      entry.source === other.source &&
      entry.updatedAt === other.updatedAt
    )
  })
}
