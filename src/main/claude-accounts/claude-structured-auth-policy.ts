import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { shouldStripClaudeAuthEnvForAccount } from './environment'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'
import { UNKNOWN_CLAUDE_LIVE_PTY_BINDING, type ClaudeLivePtyBinding } from './live-pty-gate'
import type {
  ClaudeConfigDirRoute,
  ClaudeRuntimeAuthPreparation
} from './runtime-auth/runtime-auth-types'

/** The structured mirror of the terminal preflight's `prepareClaudeAuth` result:
 *  the fields a launch resolution needs from the managed-account state. */
export type ClaudeStructuredAuthPolicy = {
  stripAuthEnv: boolean
  /** The managed account this launch runs as, so its child can hold the OAuth
   *  refresh gate for that account alone rather than for every account. */
  accountId?: string | null
  /**
   * The credential surface this policy was actually PREPARED for.
   *
   * A structured session launches against `record.accountHome.path`, fixed when
   * the session was created and immutable afterwards — not against whatever
   * account happens to be selected now. Carrying the prepared dir lets the
   * resolver prove the two agree before it binds the OAuth refresh gate; a
   * policy that describes another surface is refused rather than mis-attributed.
   */
  preparedConfigDir?: string | null
  configDirRoute?: ClaudeConfigDirRoute
}

/**
 * The settings-derived policy: what the ACTIVE host selection implies.
 *
 * It exists as a named function rather than an inline object at the wiring site so
 * that the settings-to-policy mapping is testable on its own: a wiring that lives
 * in a `@ts-nocheck` file is one where neither the compiler nor a type test can
 * see a dropped field.
 *
 * NEVER build a structured launch's policy from this. A structured session runs
 * against the config dir its record was created with, which is not necessarily
 * the active selection — binding the refresh gate to the active account while the
 * child holds another account's credentials is what
 * `claudeStructuredAuthPolicyForLaunchSurface` exists to prevent.
 */
export function claudeStructuredAuthPolicyForSettings(
  settings: Pick<
    GlobalSettings,
    | 'claudeManagedAccounts'
    | 'activeClaudeManagedAccountId'
    | 'activeClaudeManagedAccountIdsByRuntime'
  >
): ClaudeStructuredAuthPolicy {
  const accountId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
  const account = settings.claudeManagedAccounts.find((candidate) => candidate.id === accountId)
  return {
    stripAuthEnv: shouldStripClaudeAuthEnvForAccount(settings.claudeManagedAccounts, accountId),
    // Why: a WSL-runtime account is not what a structured (always local-host)
    // launch runs as, so it must not claim that account's gate.
    accountId: account && account.managedAuthRuntime !== 'wsl' ? account.id : null
  }
}

/**
 * The structured launch's auth policy, derived from the surface it will actually
 * launch against.
 *
 * `prepareLaunchSurface` is the structured transport's half of the terminal
 * preflight: it resolves which managed account owns that config dir, materializes
 * that account's credentials into its own dir, and refuses a launch whose grant a
 * pre-isolation Claude still owns on the shared surface. Its refusals are thrown,
 * exactly as `prepareForClaudeLaunch` throws for the terminal path — one refusal
 * rule for both transports.
 */
export async function claudeStructuredAuthPolicyForLaunchSurface(
  claudeConfigDir: string,
  prepareLaunchSurface: (configDir: string) => Promise<ClaudeRuntimeAuthPreparation>
): Promise<ClaudeStructuredAuthPolicy> {
  const preparation = await prepareLaunchSurface(claudeConfigDir)
  return {
    stripAuthEnv: preparation.stripAuthEnv,
    accountId: preparation.accountId ?? null,
    preparedConfigDir: preparation.configDir,
    ...(preparation.configDirRoute ? { configDirRoute: preparation.configDirRoute } : {})
  }
}

export type ClaudeStructuredAuthBindingResolution =
  | { ok: true; binding: ClaudeLivePtyBinding }
  | { ok: false; reason: string }

/**
 * The OAuth-refresh-gate binding for a structured child, proved against the dir
 * that child is launched with.
 *
 * Every answer here is either the surface the child really holds or a refusal.
 * A binding naming an account the child does not run as is worse than none: it
 * frees that account's single-use refresh token for a proactive rotation while
 * the child still holds it, and defers the rotation of an account nothing holds.
 */
export function claudeStructuredLaunchAuthBinding(
  policy: ClaudeStructuredAuthPolicy,
  claudeConfigDir: string
): ClaudeStructuredAuthBindingResolution {
  if (policy.preparedConfigDir == null) {
    // A policy that names no surface proves nothing about this one, so claim no
    // account: `unknown` keeps the shared surface frozen while the child lives
    // and never releases an account's refresh token. Only hand-built policies
    // (fixtures) land here — the production wiring always states its surface.
    return { ok: true, binding: UNKNOWN_CLAUDE_LIVE_PTY_BINDING }
  }
  if (!isSameClaudeConfigDir(policy.preparedConfigDir, claudeConfigDir)) {
    return {
      ok: false,
      reason: `claude auth was prepared for ${policy.preparedConfigDir}, but this session launches against ${claudeConfigDir}`
    }
  }
  if (policy.configDirRoute === 'shared-dir') {
    return { ok: true, binding: { route: 'shared-dir' } }
  }
  if (policy.configDirRoute === 'account-dir') {
    return policy.accountId
      ? { ok: true, binding: { route: 'account-dir', accountId: policy.accountId } }
      : {
          ok: false,
          // An account dir with no account names no surface at all: it matches no
          // account in the per-account gate and is excluded from the shared one.
          reason: `claude auth prepared ${claudeConfigDir} as an account directory without naming its account`
        }
  }
  return {
    ok: false,
    reason: `claude structured launches run on the local host; ${policy.configDirRoute ?? 'an unrouted'} credential surface cannot be bound`
  }
}

/**
 * Two spellings of one config dir. The record stores the dir the account service
 * resolved when the session was created; the preparation answers with the path it
 * canonicalizes now. Case and separators are settled by normalization, and a
 * symlinked prefix (`/var` vs `/private/var`) by a realpath pass that only runs
 * when the cheap comparison already disagrees — a path that cannot be read at all
 * stays a mismatch, which refuses the launch.
 */
export function isSameClaudeConfigDir(left: string, right: string): boolean {
  const normalizedLeft = normalizeRuntimePathForComparison(resolve(left))
  const normalizedRight = normalizeRuntimePathForComparison(resolve(right))
  if (normalizedLeft === normalizedRight) {
    return true
  }
  try {
    return (
      normalizeRuntimePathForComparison(realpathSync(left)) ===
      normalizeRuntimePathForComparison(realpathSync(right))
    )
  } catch {
    return false
  }
}
