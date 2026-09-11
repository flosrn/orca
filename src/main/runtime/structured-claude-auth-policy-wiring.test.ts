import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED,
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

/**
 * The structured host's Claude auth policy has exactly one production wiring, and it
 * lives in `orca-runtime-get-worktree-ps.ts` — a `@ts-nocheck` file, so neither the
 * compiler nor a type test can see the field disappear. Deleting that wiring used to
 * leave ~1000 tests green while every `ANTHROPIC_*` variable in the shell reached the
 * child, because `stripAuthEnv` silently fell back to `false`.
 *
 * The guard is that the host refuses to install without one: what the policy then
 * means is pinned behaviourally by claude-structured-auth-policy.test.ts and
 * claude-structured-launch-resolution.test.ts.
 */
describe('structured Claude auth policy wiring', () => {
  describe('installing without one', () => {
    let stateDirectory: string | null = null

    afterEach(async () => {
      await stopStructuredAgentSessionRuntime()
      if (stateDirectory) {
        await rm(stateDirectory, { recursive: true, force: true })
        stateDirectory = null
      }
    })

    it('refuses loudly rather than defaulting to a guess', async () => {
      stateDirectory = await mkdtemp(join(tmpdir(), 'orca-auth-policy-wiring-'))

      await expect(
        ensureStructuredAgentSessionHost({
          stateDirectory,
          hostId: 'local',
          claimKeyId: 'key-1',
          resolveWorkspacePath: async () => stateDirectory as string
        } as unknown as Parameters<typeof ensureStructuredAgentSessionHost>[0])
      ).rejects.toThrow(CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED)
    })
  })
})
