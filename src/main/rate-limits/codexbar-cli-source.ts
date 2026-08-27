import { runProcess, type ProcessResult } from '../../shared/child-process/run-process'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { buildLocalPreflightEnv } from '../ipc/preflight-local-env'
import {
  CODEXBAR_PROVIDER_CLI_ARGUMENT,
  CODEXBAR_PROVIDERS,
  failure,
  mapCodexBarUsage,
  type CodexBarMapResult,
  type CodexBarProvider
} from './codexbar-usage-mapper'

const CODEXBAR_BINARY = 'codexbar'

/**
 * Per-provider ceiling. Measured 2026-08-27: C‍linePass ~2.3s, C‍ursor ~4s, Qwen Cloud ~3s, with
 * Claude the slowest at ~7.9s. CodexBar reaches out to provider dashboards, so the budget has to
 * cover a cold web fetch — but it must stay under the poll interval or a slow provider would pin
 * a fetch across cycles.
 */
const CODEXBAR_TIMEOUT_MS = 20_000

/**
 * CodexBar can print progress logs; usage JSON is small. Cap captured output so a chatty or
 * wedged binary cannot buffer megabytes into the main process.
 */
const CODEXBAR_MAX_OUTPUT_BYTES = 512 * 1024

export type CodexBarAvailability = {
  /** Absolute path to the binary, or null when CodexBar is not installed on this host. */
  binaryPath: string | null
}

/**
 * Locate the CodexBar binary.
 *
 * Why not gated on `process.platform === 'darwin'`: CodexBar ships a macOS app, but the CLI is a
 * plain executable a user can put on PATH anywhere, and Orca runs on Linux and Windows too.
 * Presence of the binary is the only honest signal — the platform is not.
 */
export async function resolveCodexBarBinary(): Promise<CodexBarAvailability> {
  const binaryPath = await resolveCommandOnLocalPath(CODEXBAR_BINARY, {
    env: buildLocalPreflightEnv()
  })
  return { binaryPath }
}

/**
 * Read one provider's usage through the CodexBar CLI.
 *
 * Never throws: a spawn failure, a non-zero exit, a timeout, and a malformed payload all resolve
 * to an error-status `ProviderRateLimits`, because one broken provider must not abort the others.
 */
export async function fetchCodexBarProvider(
  provider: CodexBarProvider,
  binaryPath: string,
  options: { signal?: AbortSignal } = {}
): Promise<CodexBarMapResult> {
  let result: ProcessResult
  try {
    result = await runProcess({
      program: binaryPath,
      args: [
        'usage',
        '--provider',
        CODEXBAR_PROVIDER_CLI_ARGUMENT[provider],
        '--format',
        'json',
        // Why: without this the CLI can wrap JSON in ANSI colour codes, which JSON.parse rejects.
        '--no-color'
      ],
      timeoutMs: CODEXBAR_TIMEOUT_MS,
      maxOutputBytes: CODEXBAR_MAX_OUTPUT_BYTES,
      signal: options.signal
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failure(provider, `CodexBar could not be run: ${message}`, 'cli-unavailable')
  }

  if (result.timedOut) {
    return failure(provider, 'CodexBar did not respond in time', 'network')
  }

  // Why parse stdout even on a non-zero exit: the CLI exits 1 for a provider-level auth error and
  // still prints the structured `{"error":{...}}` payload, whose message is better than "exit 1".
  const stdout = result.stdout.trim()
  if (stdout.length > 0) {
    return mapCodexBarUsage(provider, stdout)
  }

  const stderr = result.stderr.trim()
  return failure(
    provider,
    stderr.length > 0 ? stderr : `CodexBar exited with code ${result.code ?? 'unknown'}`,
    'cli-unavailable'
  )
}

export type CodexBarUsageSnapshot = {
  /** Null when CodexBar is not installed; the providers then stay off the bar entirely. */
  binaryPath: string | null
  results: Partial<Record<CodexBarProvider, CodexBarMapResult>>
}

/**
 * Read every CodexBar-backed provider in one pass.
 *
 * Parallel, not serial: each provider costs its own network round trip, and measured serially the
 * three add up to roughly the sum of their latencies instead of the slowest one.
 */
export async function fetchCodexBarUsage(
  options: { signal?: AbortSignal } = {}
): Promise<CodexBarUsageSnapshot> {
  const { binaryPath } = await resolveCodexBarBinary()
  if (binaryPath === null) {
    return { binaryPath: null, results: {} }
  }
  const settled = await Promise.all(
    CODEXBAR_PROVIDERS.map(async (provider) => {
      return [provider, await fetchCodexBarProvider(provider, binaryPath, options)] as const
    })
  )
  return { binaryPath, results: Object.fromEntries(settled) }
}
