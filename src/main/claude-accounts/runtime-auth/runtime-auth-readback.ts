import { existsSync, readFileSync } from 'node:fs'
import { ClaudeRuntimeAuthCredentialMatching } from './runtime-auth-credential-matching'
import type {
  ClaudeReadBackMatch,
  ClaudeReadBackResult,
  ClaudeRuntimeCredentialCandidate
} from './runtime-auth-types'

export class ClaudeRuntimeAuthReadback extends ClaudeRuntimeAuthCredentialMatching {
  protected async readBackRefreshedTokens(
    baselineCredentialsJson: string,
    options: { updateLastWrittenCredentialsJson: boolean }
  ): Promise<ClaudeReadBackResult> {
    try {
      const candidates =
        await this.readRuntimeCredentialCandidatesForReadBack(baselineCredentialsJson)
      if (candidates.length === 0) {
        return { status: 'unchanged' }
      }
      const changedCandidates =
        this.lastWrittenCredentialsJson === null
          ? candidates
          : candidates.filter(
              (candidate) => candidate.credentialsJson !== this.lastWrittenCredentialsJson
            )
      if (changedCandidates.length === 0) {
        return { status: 'unchanged' }
      }

      const acceptedCandidates: {
        credentialsJson: string
        match: Extract<ClaudeReadBackMatch, { kind: 'matched' }>
      }[] = []
      const ambiguousCandidates: string[] = []
      let sawAmbiguousCandidate = false
      let sawValidChangedCandidate = false
      for (const runtimeContents of changedCandidates) {
        if (!this.isValidCredentialsJsonObject(runtimeContents.credentialsJson)) {
          continue
        }
        sawValidChangedCandidate = true
        const match = await this.findManagedAccountForRuntimeCredentials(
          runtimeContents.credentialsJson,
          runtimeContents.runtimeOauthAccount
        )
        if (match.kind === 'ambiguous') {
          sawAmbiguousCandidate = true
          ambiguousCandidates.push(runtimeContents.credentialsJson)
          continue
        }
        if (match.kind !== 'matched') {
          continue
        }
        // Why: on cold start we can't tell a fresh CLI refresh from stale runtime creds; adopt only when expiry or a rotated refresh token proves runtime is newer than managed.
        if (this.lastWrittenCredentialsJson === null) {
          const fresher = this.runtimeCredentialsAreFresher(
            runtimeContents.credentialsJson,
            match.managedCredentialsJson
          )
          const refreshTokenRotated =
            this.compareRefreshTokens(
              runtimeContents.credentialsJson,
              match.managedCredentialsJson
            ) === 'different'
          const older = this.runtimeCredentialsAreOlder(
            runtimeContents.credentialsJson,
            match.managedCredentialsJson
          )
          if (!fresher && !(refreshTokenRotated && !older)) {
            continue
          }
        } else if (
          this.runtimeCredentialsAreOlder(
            runtimeContents.credentialsJson,
            match.managedCredentialsJson
          )
        ) {
          continue
        }
        acceptedCandidates.push({ credentialsJson: runtimeContents.credentialsJson, match })
      }
      if (acceptedCandidates.length === 0) {
        if (sawAmbiguousCandidate) {
          console.warn('[claude-runtime-auth] Refusing ambiguous Claude auth read-back')
        }
        return {
          status: 'rejected',
          runtimeCredentialsChanged: true,
          hasValidChangedRuntimeCredentials: sawValidChangedCandidate,
          runtimeCredentialsJson:
            ambiguousCandidates.length === 1 ? ambiguousCandidates[0] : undefined
        }
      }
      const { credentialsJson: runtimeContents, match } =
        this.chooseFreshestReadBackCandidate(acceptedCandidates)

      await this.writeManagedCredentials(match.account, runtimeContents)
      if (options.updateLastWrittenCredentialsJson) {
        this.writeRuntimeCredentials(runtimeContents)
        this.lastWrittenCredentialsJson = runtimeContents
        if (process.platform === 'darwin') {
          // Why: publishes to whichever surface this selection owns — a pinned
          // account's own scoped item, or the shared pair. A pinned account
          // must not write the unscoped item (see
          // writeActiveRuntimeKeychainCredentials).
          await this.writeActiveRuntimeKeychainCredentials(runtimeContents)
        }
      }
      return { status: 'persisted' }
    } catch (error) {
      // Why: read-back is best-effort; a transient fs error must not block forward sync (worst case: one more stale-token cycle).
      console.warn('[claude-runtime-auth] Failed to read back refreshed tokens:', error)
      return {
        status: 'rejected',
        runtimeCredentialsChanged:
          this.runtimeCredentialsChangedSinceLastWrite(baselineCredentialsJson),
        // Why: an fs error hides whether a live session's refresh is present, so err toward preserving runtime state.
        hasValidChangedRuntimeCredentials: true
      }
    }
  }

  protected async readRuntimeCredentialCandidatesForReadBack(
    baselineCredentialsJson: string
  ): Promise<ClaudeRuntimeCredentialCandidate[]> {
    const paths = this.getActiveRuntimePaths()
    const fileCredentials = existsSync(paths.credentialsPath)
      ? readFileSync(paths.credentialsPath, 'utf-8')
      : null
    const runtimeOauthAccount = this.readRuntimeOauthAccount()
    const candidates: ClaudeRuntimeCredentialCandidate[] = []
    const pushCandidate = (credentialsJson: string | null): void => {
      if (
        credentialsJson &&
        !candidates.some((candidate) => candidate.credentialsJson === credentialsJson)
      ) {
        candidates.push({ credentialsJson, runtimeOauthAccount })
      }
    }
    if (process.platform === 'darwin') {
      const scopedKeychainCredentials = await this.readActiveClaudeKeychainCredentialsBestEffort(
        paths.configDir
      )
      // Why: the unscoped `Claude Code-credentials` item belongs to the user's
      // own ~/.claude. A pinned account reading it back would adopt another
      // surface's token as its own rotation, which is the leak this isolation
      // removes; only the shared selection may treat it as its runtime.
      const legacyKeychainCredentials = this.pinnedAccountConfigDir
        ? null
        : await this.readActiveClaudeKeychainCredentialsBestEffort()
      if (this.lastWrittenCredentialsJson === null) {
        pushCandidate(scopedKeychainCredentials)
        pushCandidate(legacyKeychainCredentials)
        pushCandidate(fileCredentials)
        return candidates.filter(
          (candidate) => candidate.credentialsJson !== baselineCredentialsJson
        )
      }
      pushCandidate(scopedKeychainCredentials)
      pushCandidate(legacyKeychainCredentials)
    }
    pushCandidate(fileCredentials)
    return candidates
  }
}
