import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { CLAUDE_AUTH_ENV_VARS } from './environment'

/**
 * A host managed account runs with CLAUDE_CONFIG_DIR pinned to its own
 * directory, which isolates its credentials — and, left alone, would also
 * isolate everything else Claude Code reads out of that directory: settings and
 * hooks, the statusline, global CLAUDE.md, agents, commands, skills, MCP
 * servers, and session/project history. Switching account would silently look
 * like a factory reset.
 *
 * So each account directory links or merges the user's own ~/.claude resources,
 * the way codex-home-paths.ts does for a per-account CODEX_HOME. Credentials are
 * the one thing that stays per-account.
 */

/** Shared by reference: the user edits ~/.claude, every account sees it, and a
 *  write from inside a session lands in the user's real file. Session history
 *  (`projects`, `todos`) is shared on purpose — a resumed conversation must not
 *  vanish because the pane was reopened under another account. */
const LINKED_CLAUDE_RESOURCE_ENTRIES = [
  'CLAUDE.md',
  'agents',
  'commands',
  'output-styles',
  'plugins',
  'skills',
  'projects',
  'todos'
] as const

/** Settings keys that can hand a launch its own Anthropic credentials, which is
 *  exactly what a managed account exists to prevent. `env` is filtered key by
 *  key; these two are dropped whole. */
const AUTH_BEARING_SETTINGS_KEYS = ['apiKeyHelper', 'awsAuthRefresh'] as const

export function getSystemClaudeConfigDir(): string {
  return join(homedir(), '.claude')
}

/**
 * Makes `configDir` a complete Claude config directory for one account.
 *
 * Safe to call before every launch: it adds what is missing and never
 * overwrites a value the account directory already carries, because Claude Code
 * itself writes into that directory during a session.
 */
export function syncSystemClaudeResourcesIntoAccountConfigDir(configDir: string): void {
  const systemConfigDir = getSystemClaudeConfigDir()
  if (systemConfigDir === configDir) {
    return
  }
  mkdirSync(configDir, { recursive: true })
  for (const entryName of LINKED_CLAUDE_RESOURCE_ENTRIES) {
    linkSystemResource(join(systemConfigDir, entryName), join(configDir, entryName))
  }
  mirrorSettingsJson(systemConfigDir, configDir)
  mirrorClaudeJson(configDir)
}

function linkSystemResource(sourcePath: string, targetPath: string): void {
  // Why: an unreadable source is not an absent one. Leave whatever the account
  // directory already has rather than acting on a failed stat.
  if (!pathExists(sourcePath) || pathExists(targetPath)) {
    return
  }
  try {
    symlinkSync(
      sourcePath,
      targetPath,
      lstatSync(sourcePath).isDirectory() && process.platform === 'win32' ? 'junction' : undefined
    )
  } catch (error) {
    // Why: Windows rejects symlinks outside developer mode. A missing link
    // degrades to "this account does not see that resource", which is survivable;
    // failing the launch is not.
    console.warn('[claude-account-config] Could not link Claude resource:', targetPath, error)
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * settings.json carries hooks and the statusline, so an account without it is a
 * pane with no Orca integration. Shared keys are merged in; keys the account
 * file already defines win, because those are what the CLI or the user set from
 * inside this account's sessions.
 */
function mirrorSettingsJson(systemConfigDir: string, configDir: string): void {
  const systemSettings = readJsonObject(join(systemConfigDir, 'settings.json'))
  if (!systemSettings) {
    return
  }
  const targetPath = join(configDir, 'settings.json')
  const accountSettings = readJsonObject(targetPath) ?? {}
  const merged: Record<string, unknown> = { ...accountSettings }
  for (const [key, value] of Object.entries(systemSettings)) {
    if (!(key in merged)) {
      merged[key] = value
    }
  }
  for (const key of AUTH_BEARING_SETTINGS_KEYS) {
    delete merged[key]
  }
  merged.env = sanitizeSettingsEnv(merged.env)
  if (merged.env === undefined) {
    delete merged.env
  }
  const serialized = `${JSON.stringify(merged, null, 2)}\n`
  if (readFileOrNull(targetPath) === serialized) {
    return
  }
  writeFileAtomically(targetPath, serialized, { mode: 0o600 })
}

/**
 * settings.json `env` is applied to every Claude process, so an inherited
 * ANTHROPIC_API_KEY there would re-enter through the back door a managed launch
 * strips at the front (see applyClaudeEnvPatch's stripAuthEnv).
 */
function sanitizeSettingsEnv(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const sanitized: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const isAuthVar = CLAUDE_AUTH_ENV_VARS.some(
      (authKey) => authKey === key || authKey === key.toUpperCase()
    )
    if (isAuthVar || key.toUpperCase() === 'ANTHROPIC_CUSTOM_HEADERS') {
      continue
    }
    sanitized[key] = entry
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

/**
 * `.claude.json` mixes account-independent configuration (MCP servers, project
 * entries, onboarding flags) with identity (`oauthAccount`, `userID`) and API
 * credentials. Only the former crosses into an account directory: copying the
 * file wholesale would import one account's identity into another's session,
 * which is the bug this whole change exists to remove.
 */
function mirrorClaudeJson(configDir: string): void {
  const systemClaudeJson = readJsonObject(resolveSystemClaudeJsonPath())
  if (!systemClaudeJson) {
    return
  }
  const targetPath = join(configDir, '.claude.json')
  const accountClaudeJson = readJsonObject(targetPath) ?? {}
  const merged: Record<string, unknown> = { ...accountClaudeJson }
  const systemMcpServers = asObject(systemClaudeJson.mcpServers)
  if (systemMcpServers) {
    const accountMcpServers = asObject(merged.mcpServers) ?? {}
    const mergedMcpServers: Record<string, unknown> = { ...accountMcpServers }
    for (const [name, definition] of Object.entries(systemMcpServers)) {
      if (!(name in mergedMcpServers)) {
        mergedMcpServers[name] = definition
      }
    }
    merged.mcpServers = mergedMcpServers
  }
  for (const key of ACCOUNT_INDEPENDENT_CLAUDE_JSON_KEYS) {
    if (!(key in merged) && key in systemClaudeJson) {
      merged[key] = systemClaudeJson[key]
    }
  }
  const serialized = `${JSON.stringify(merged, null, 2)}\n`
  if (readFileOrNull(targetPath) === serialized) {
    return
  }
  writeFileAtomically(targetPath, serialized, { mode: 0o600 })
}

/** Everything else in `.claude.json` — `oauthAccount`, `userID`,
 *  `primaryApiKey`, `customApiKeyResponses` — is identity or credential and is
 *  deliberately never mirrored. */
const ACCOUNT_INDEPENDENT_CLAUDE_JSON_KEYS = [
  'projects',
  'hasCompletedOnboarding',
  'bypassPermissionsModeAccepted',
  'editorMode',
  'autoUpdates',
  'theme',
  'verbose'
] as const

function resolveSystemClaudeJsonPath(): string {
  const colocated = join(getSystemClaudeConfigDir(), '.claude.json')
  return existsSync(colocated) ? colocated : join(homedir(), '.claude.json')
}

function readJsonObject(path: string): Record<string, unknown> | null {
  const raw = readFileOrNull(path)
  if (raw === null) {
    return null
  }
  try {
    return asObject(JSON.parse(raw))
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}
