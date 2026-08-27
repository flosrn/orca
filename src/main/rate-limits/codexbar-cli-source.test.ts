import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../../shared/child-process/run-process'

const mocks = vi.hoisted(() => ({
  runProcess:
    vi.fn<(spec: { program: string; args?: readonly string[] }) => Promise<ProcessResult>>(),
  resolveCommandOnLocalPath: vi.fn<(command: string) => Promise<string | null>>()
}))

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: mocks.runProcess }))
vi.mock('../ipc/command-path-resolver', () => ({
  resolveCommandOnLocalPath: mocks.resolveCommandOnLocalPath
}))
vi.mock('../ipc/preflight-local-env', () => ({ buildLocalPreflightEnv: () => undefined }))

const { fetchCodexBarProvider, fetchCodexBarUsage } = await import('./codexbar-cli-source')

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

const WEEKLY_PAYLOAD = JSON.stringify([
  {
    provider: 'clinepass',
    source: 'api',
    usage: { secondary: { usedPercent: 38, windowMinutes: 10080 } }
  }
])

describe('fetchCodexBarUsage', () => {
  beforeEach(() => {
    mocks.runProcess.mockReset()
    mocks.resolveCommandOnLocalPath.mockReset()
  })

  it('reports no binary without spawning anything', async () => {
    mocks.resolveCommandOnLocalPath.mockResolvedValue(null)

    const snapshot = await fetchCodexBarUsage()

    // An absent CLI is not a provider failure: the three meters must stay off the bar entirely
    // rather than render three error rows for software the user never installed.
    expect(snapshot.binaryPath).toBeNull()
    expect(snapshot.results).toEqual({})
    expect(mocks.runProcess).not.toHaveBeenCalled()
  })

  it('resolves the binary by PATH presence, never by platform', async () => {
    mocks.resolveCommandOnLocalPath.mockResolvedValue('/opt/homebrew/bin/codexbar')
    mocks.runProcess.mockResolvedValue(processResult({ stdout: WEEKLY_PAYLOAD }))

    const snapshot = await fetchCodexBarUsage()

    expect(mocks.resolveCommandOnLocalPath).toHaveBeenCalledWith('codexbar', { env: undefined })
    expect(snapshot.binaryPath).toBe('/opt/homebrew/bin/codexbar')
  })

  it('queries every provider in one pass with the hyphenated Qwen argument', async () => {
    mocks.resolveCommandOnLocalPath.mockResolvedValue('/usr/local/bin/codexbar')
    mocks.runProcess.mockResolvedValue(processResult({ stdout: WEEKLY_PAYLOAD }))

    const snapshot = await fetchCodexBarUsage()

    expect(mocks.runProcess).toHaveBeenCalledTimes(3)
    const requested = mocks.runProcess.mock.calls.map(([spec]) => {
      return spec.args?.[spec.args.indexOf('--provider') + 1]
    })
    expect(requested).toEqual(['cursor', 'clinepass', 'qwen-cloud'])
    expect(Object.keys(snapshot.results)).toEqual(['cursor', 'clinepass', 'qwencloud'])
  })

  it('always spawns the resolved absolute path, not the bare command name', async () => {
    mocks.resolveCommandOnLocalPath.mockResolvedValue('/opt/homebrew/bin/codexbar')
    mocks.runProcess.mockResolvedValue(processResult({ stdout: WEEKLY_PAYLOAD }))

    await fetchCodexBarUsage()

    // Why: on Windows a bare name lets the child's own PATH decide what runs.
    for (const [spec] of mocks.runProcess.mock.calls) {
      expect(spec.program).toBe('/opt/homebrew/bin/codexbar')
    }
  })

  it('suppresses ANSI colour so stdout stays parseable', async () => {
    mocks.resolveCommandOnLocalPath.mockResolvedValue('/usr/bin/codexbar')
    mocks.runProcess.mockResolvedValue(processResult({ stdout: WEEKLY_PAYLOAD }))

    await fetchCodexBarUsage()

    expect(mocks.runProcess.mock.calls[0][0].args).toContain('--no-color')
  })

  it('keeps one provider’s failure from taking down the others', async () => {
    mocks.resolveCommandOnLocalPath.mockResolvedValue('/usr/bin/codexbar')
    mocks.runProcess
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValue(processResult({ stdout: WEEKLY_PAYLOAD }))

    const snapshot = await fetchCodexBarUsage()

    expect(snapshot.results.cursor?.limits.status).toBe('error')
    expect(snapshot.results.clinepass?.limits.status).toBe('ok')
    expect(snapshot.results.qwencloud?.limits.status).toBe('ok')
  })
})

describe('fetchCodexBarProvider', () => {
  beforeEach(() => {
    mocks.runProcess.mockReset()
  })

  it('maps a spawn rejection to a cli-unavailable failure', async () => {
    mocks.runProcess.mockRejectedValue(new Error('spawn ENOENT'))

    const { limits } = await fetchCodexBarProvider('cursor', '/usr/bin/codexbar')

    expect(limits.status).toBe('error')
    expect(limits.error).toContain('spawn ENOENT')
    expect(limits.usageMetadata?.failureKind).toBe('cli-unavailable')
  })

  it('maps a timeout to a network failure', async () => {
    mocks.runProcess.mockResolvedValue(processResult({ timedOut: true, code: null }))

    const { limits } = await fetchCodexBarProvider('clinepass', '/usr/bin/codexbar')

    expect(limits.status).toBe('error')
    expect(limits.usageMetadata?.failureKind).toBe('network')
  })

  it('still reads the structured payload from a non-zero exit', async () => {
    // CodexBar exits 1 for a provider auth error and prints the useful message on stdout.
    const raw = JSON.stringify([
      { provider: 'alibaba', error: { kind: 'provider', message: 'Console login required.' } }
    ])
    mocks.runProcess.mockResolvedValue(processResult({ code: 1, stdout: raw }))

    const { limits } = await fetchCodexBarProvider('qwencloud', '/usr/bin/codexbar')

    expect(limits.error).toBe('Console login required.')
    expect(limits.usageMetadata?.failureKind).toBe('missing-credentials')
  })

  it('falls back to stderr when the CLI prints nothing on stdout', async () => {
    mocks.runProcess.mockResolvedValue(processResult({ code: 2, stderr: 'config file missing' }))

    const { limits } = await fetchCodexBarProvider('cursor', '/usr/bin/codexbar')

    expect(limits.error).toBe('config file missing')
    expect(limits.usageMetadata?.failureKind).toBe('cli-unavailable')
  })

  it('reports the exit code when the CLI is silent on both streams', async () => {
    mocks.runProcess.mockResolvedValue(processResult({ code: 3 }))

    const { limits } = await fetchCodexBarProvider('cursor', '/usr/bin/codexbar')

    expect(limits.error).toContain('3')
  })

  it('bounds runtime and captured output', async () => {
    mocks.runProcess.mockResolvedValue(processResult({ stdout: WEEKLY_PAYLOAD }))

    await fetchCodexBarProvider('cursor', '/usr/bin/codexbar')

    const spec = mocks.runProcess.mock.calls[0][0] as {
      timeoutMs?: number | null
      maxOutputBytes?: number
    }
    expect(spec.timeoutMs).toBeGreaterThan(0)
    expect(spec.maxOutputBytes).toBeGreaterThan(0)
  })
})
