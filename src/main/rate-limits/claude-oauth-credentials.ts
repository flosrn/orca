import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict
} from '../claude-accounts/keychain'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

type ClaudeCredentials = {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
  }
}

export type ClaudeOAuthCredentialSource =
  | 'scoped-keychain'
  | 'legacy-keychain'
  | 'credentials-file'
  | 'none'

export type ClaudeOAuthCredentialReadResult = {
  token: string | null
  hasRefreshableCredentials: boolean
  source: ClaudeOAuthCredentialSource
  keychainUnavailable?: boolean
}

type ClaudeOAuthCredentialReadOptions = {
  credentialsFileConfigDir?: string
  keychainConfigDir?: string
  /**
   * Whether a scoped miss may fall back to the unscoped `Claude Code-credentials`
   * item. True for the user's own ~/.claude, whose older Claude builds wrote
   * there. False for a managed account's own dir: that item belongs to another
   * surface, and reading it would report one account's quota under another's
   * name.
   */
  allowUnscopedKeychainFallback?: boolean
}

export function parseClaudeOAuthCredentialsJson(
  raw: string,
  source: ClaudeOAuthCredentialSource
): ClaudeOAuthCredentialReadResult {
  try {
    const oauth = (JSON.parse(raw) as ClaudeCredentials)?.claudeAiOauth
    const hasRefreshableCredentials =
      typeof oauth?.refreshToken === 'string' && oauth.refreshToken.trim() !== ''
    if (!oauth?.accessToken || typeof oauth.accessToken !== 'string') {
      return { token: null, hasRefreshableCredentials, source }
    }
    // Why: expiresAt is not authoritative for the usage endpoint; let the server decide.
    return { token: oauth.accessToken, hasRefreshableCredentials, source }
  } catch {
    return emptyClaudeOAuthCredentialReadResult()
  }
}

export function emptyClaudeOAuthCredentialReadResult(): ClaudeOAuthCredentialReadResult {
  return { token: null, hasRefreshableCredentials: false, source: 'none' }
}

function unavailableKeychainResult(): ClaudeOAuthCredentialReadResult {
  return {
    token: null,
    hasRefreshableCredentials: false,
    source: 'none',
    keychainUnavailable: true
  }
}

async function readFromKeychain(
  configDir: string | undefined,
  allowUnscopedFallback: boolean
): Promise<ClaudeOAuthCredentialReadResult> {
  if (process.platform !== 'darwin') {
    return emptyClaudeOAuthCredentialReadResult()
  }

  if (configDir) {
    const scoped = await readClaudeCredentialsFromStrictKeychain(configDir, 'scoped-keychain')
    if (scoped.token || !allowUnscopedFallback) {
      return scoped
    }

    const legacy = await readClaudeCredentialsFromStrictKeychain(undefined, 'legacy-keychain')
    // Why: a real access token must not be shadowed by scoped refresh-only credentials.
    if (legacy.token) {
      return legacy
    }
    if (scoped.hasRefreshableCredentials) {
      return scoped
    }
    if (legacy.hasRefreshableCredentials) {
      return legacy
    }
    return scoped.keychainUnavailable || legacy.keychainUnavailable
      ? unavailableKeychainResult()
      : legacy
  }

  try {
    const credentials = await readActiveClaudeKeychainCredentials(configDir)
    return credentials
      ? parseClaudeOAuthCredentialsJson(credentials, 'legacy-keychain')
      : emptyClaudeOAuthCredentialReadResult()
  } catch {
    return unavailableKeychainResult()
  }
}

export async function readClaudeCredentialsFromStrictKeychain(
  configDir: string | undefined,
  source: ClaudeOAuthCredentialSource
): Promise<ClaudeOAuthCredentialReadResult> {
  try {
    const credentials = await readActiveClaudeKeychainCredentialsStrict(configDir)
    return credentials
      ? parseClaudeOAuthCredentialsJson(credentials, source)
      : emptyClaudeOAuthCredentialReadResult()
  } catch {
    return unavailableKeychainResult()
  }
}

async function readFromCredentialsFile(
  configDir?: string
): Promise<ClaudeOAuthCredentialReadResult> {
  const credentialPath = path.join(
    configDir ?? path.join(homedir(), '.claude'),
    '.credentials.json'
  )
  try {
    return parseClaudeOAuthCredentialsJson(
      await readFile(credentialPath, 'utf-8'),
      'credentials-file'
    )
  } catch {
    return emptyClaudeOAuthCredentialReadResult()
  }
}

export async function readClaudeOAuthCredentials(
  options?: ClaudeOAuthCredentialReadOptions
): Promise<ClaudeOAuthCredentialReadResult> {
  const keychain = await readFromKeychain(
    options?.keychainConfigDir,
    options?.allowUnscopedKeychainFallback ?? true
  )
  if (keychain.token || keychain.hasRefreshableCredentials) {
    return keychain
  }

  const file = await readFromCredentialsFile(options?.credentialsFileConfigDir)
  if (file.token || file.hasRefreshableCredentials) {
    return file
  }
  return keychain.keychainUnavailable ? keychain : emptyClaudeOAuthCredentialReadResult()
}

export function resolveClaudeOAuthCredentialReadOptions(
  authPreparation?: ClaudeRuntimeAuthPreparation
): ClaudeOAuthCredentialReadOptions | undefined {
  if (!authPreparation) {
    return undefined
  }
  return {
    credentialsFileConfigDir: authPreparation.configDir,
    keychainConfigDir: authPreparation.configDir,
    // Why: a managed account's dir owns its own Keychain item. Falling back to
    // the unscoped one would read the user's own ~/.claude token and report its
    // quota as this account's.
    allowUnscopedKeychainFallback: authPreparation.configDirRoute !== 'account-dir'
  }
}
