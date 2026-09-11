import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { hasLiveClaudePtysForAccount } from '../claude-accounts/live-pty-gate'
import { fetchViaPty } from './claude-pty'
import {
  readStagedClaudeManagedPreviewCredentials,
  withClaudeManagedPreviewKeychainCredentials,
  writeClaudeManagedCredentialsJson,
  type ClaudeManagedCredentialsLocation,
  type InactiveClaudeAccount
} from './claude-managed-account-credentials'

function getManagedUsagePanelAuthPreparation(
  account: InactiveClaudeAccount,
  location: ClaudeManagedCredentialsLocation
): ClaudeRuntimeAuthPreparation | null {
  if (process.platform === 'win32') {
    return null
  }
  if (account.managedAuthRuntime === 'wsl') {
    if (!account.wslLinuxAuthPath || !account.wslDistro) {
      return null
    }
    return {
      configDir: location.managedAuthPath,
      runtime: 'wsl',
      wslDistro: account.wslDistro,
      wslLinuxConfigDir: account.wslLinuxAuthPath,
      envPatch: { CLAUDE_CONFIG_DIR: account.wslLinuxAuthPath },
      stripAuthEnv: true,
      accountId: account.id,
      configDirRoute: 'wsl-dir',
      provenance: `managed:${account.id}:inactive-preview`
    }
  }
  return {
    configDir: location.managedAuthPath,
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: {
      CLAUDE_CONFIG_DIR: location.managedAuthPath,
      // Why: the preview CLI derives its Keychain service name from this dir.
      // Without it, it reads whatever owns the default item and reports that
      // account's quota under this one's name.
      CLAUDE_SECURESTORAGE_CONFIG_DIR: location.managedAuthPath
    },
    stripAuthEnv: true,
    accountId: account.id,
    configDirRoute: 'account-dir',
    provenance: `managed:${account.id}:inactive-preview`
  }
}

function windowsAgree(left: RateLimitWindow | null, right: RateLimitWindow | null): boolean {
  return Boolean(left && right && Math.abs(left.usedPercent - right.usedPercent) <= 1)
}

function canTrustManagedUsagePanelSupplement(
  oauthLimits: ProviderRateLimits,
  cliLimits: ProviderRateLimits,
  requireMatchingOAuthWindow: boolean
): boolean {
  if (!requireMatchingOAuthWindow) {
    return true
  }
  const sharedWindowMatches = [
    oauthLimits.session && cliLimits.session
      ? windowsAgree(oauthLimits.session, cliLimits.session)
      : null,
    oauthLimits.weekly && cliLimits.weekly
      ? windowsAgree(oauthLimits.weekly, cliLimits.weekly)
      : null
  ].filter((match): match is boolean => match !== null)
  // Why: older Claude builds may ignore the scoped Keychain and expose the active account.
  return sharedWindowMatches.length > 0 && sharedWindowMatches.every(Boolean)
}

export async function fetchClaudeManagedUsagePanelSupplement(input: {
  account: InactiveClaudeAccount
  location: ClaudeManagedCredentialsLocation
  credentialsJson: string
  oauthLimits: ProviderRateLimits
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}): Promise<ProviderRateLimits | null> {
  if (input.signal?.aborted) {
    return null
  }
  // Why: this supplement runs a Claude CLI against the account's own surface,
  // and that CLI refreshes tokens. While a session of the SAME account holds
  // the single-use refresh token, a second rotation logs one of them out — the
  // OAuth reading already gathered stands on its own.
  if (hasLiveClaudePtysForAccount(input.account.id)) {
    return null
  }
  const authPreparation = getManagedUsagePanelAuthPreparation(input.account, input.location)
  if (!authPreparation) {
    return null
  }

  return withClaudeManagedPreviewKeychainCredentials(
    input.location,
    input.credentialsJson,
    async () => {
      const cliLimits = await fetchViaPty({
        authPreparation,
        networkProxySettings: input.networkProxySettings,
        signal: input.signal
      })
      if (input.signal?.aborted) {
        return null
      }
      if (
        !canTrustManagedUsagePanelSupplement(
          input.oauthLimits,
          cliLimits,
          input.location.kind === 'keychain'
        )
      ) {
        return null
      }
      const refreshed = await readStagedClaudeManagedPreviewCredentials(input.location)
      if (refreshed && refreshed !== input.credentialsJson) {
        await writeClaudeManagedCredentialsJson(input.location, refreshed)
      }
      return cliLimits
    }
  )
}
