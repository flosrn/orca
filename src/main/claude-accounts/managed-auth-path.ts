import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

const MANAGED_AUTH_MARKER = '.orca-managed-claude-auth'

export function getClaudeManagedAccountsRoot(): string {
  return join(app.getPath('userData'), 'claude-accounts')
}

export function resolveOwnedClaudeManagedAuthPath(
  accountId: string,
  candidatePath: string,
  options: { adoptLegacyMarker?: boolean } = {}
): string | null {
  const rootPath = getClaudeManagedAccountsRoot()
  const resolvedCandidate = resolve(candidatePath)
  if (!existsSync(resolvedCandidate) || !existsSync(rootPath)) {
    return null
  }
  try {
    if (lstatSync(resolvedCandidate).isSymbolicLink()) {
      return null
    }
    const canonicalCandidate = realpathSync(resolvedCandidate)
    const canonicalRoot = realpathSync(rootPath)
    if (
      canonicalCandidate === canonicalRoot ||
      !canonicalCandidate.startsWith(canonicalRoot + sep)
    ) {
      return null
    }
    const relativePath = relative(canonicalRoot, canonicalCandidate)
    const relativeParts = relativePath.split(sep)
    const escaped = relativePath.startsWith('..') || relativePath.includes(`..${sep}`)
    if (
      escaped ||
      relativeParts.length !== 2 ||
      relativeParts[0] !== accountId ||
      relativeParts[1] !== 'auth'
    ) {
      return null
    }
    const markerPath = join(canonicalCandidate, MANAGED_AUTH_MARKER)
    const markerValid = isManagedAuthMarkerValid(markerPath, accountId)
    if (!markerValid && options.adoptLegacyMarker) {
      writeFileSync(markerPath, `${accountId}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    }
    if (!markerValid && !isManagedAuthMarkerValid(markerPath, accountId)) {
      return null
    }
    return canonicalCandidate
  } catch {
    return null
  }
}

export function readClaudeManagedAuthFile(
  managedAuthPath: string,
  filename: '.credentials.json' | 'oauth-account.json'
): string | null {
  const filePath = resolve(managedAuthPath, filename)
  try {
    if (!isOwnedChildFile(managedAuthPath, filePath)) {
      return null
    }
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

export function writeClaudeManagedAuthFile(
  managedAuthPath: string,
  filename: '.credentials.json' | 'oauth-account.json',
  contents: string
): void {
  const filePath = resolve(managedAuthPath, filename)
  if (existsSync(filePath) && !isOwnedChildFile(managedAuthPath, filePath)) {
    throw new Error('Managed Claude auth child file is not owned by Orca.')
  }
  writeFileAtomically(filePath, contents, { mode: 0o600 })
}

function isManagedAuthMarkerValid(markerPath: string, accountId: string): boolean {
  try {
    if (
      !existsSync(markerPath) ||
      lstatSync(markerPath).isSymbolicLink() ||
      !lstatSync(markerPath).isFile()
    ) {
      return false
    }
    return readFileSync(markerPath, 'utf-8').trim() === accountId
  } catch {
    return false
  }
}

/**
 * Whether a directory is one of Orca's managed Claude account auth dirs.
 *
 * Account-agnostic on purpose: the caller is the shared-surface resolver,
 * which only needs to know the dir belongs to SOME account and is therefore
 * not the user's own ~/.claude. The marker only NAMES the candidate owner;
 * ownership itself is decided by the same resolver every other caller uses,
 * so a hand-written marker in an ordinary directory proves nothing and leaves
 * an explicitly inherited CLAUDE_CONFIG_DIR alone.
 */
export function isOrcaManagedClaudeAuthDir(candidatePath: string): boolean {
  try {
    const markerPath = join(resolve(candidatePath), MANAGED_AUTH_MARKER)
    if (!existsSync(markerPath) || lstatSync(markerPath).isSymbolicLink()) {
      return false
    }
    const accountId = readFileSync(markerPath, 'utf-8').trim()
    return (
      accountId.length > 0 && resolveOwnedClaudeManagedAuthPath(accountId, candidatePath) !== null
    )
  } catch {
    return false
  }
}

function isOwnedChildFile(managedAuthPath: string, filePath: string): boolean {
  if (
    !existsSync(filePath) ||
    lstatSync(filePath).isSymbolicLink() ||
    !lstatSync(filePath).isFile()
  ) {
    return false
  }
  const canonicalAuthPath = realpathSync(managedAuthPath)
  const canonicalFilePath = realpathSync(filePath)
  return canonicalFilePath.startsWith(canonicalAuthPath + sep)
}
