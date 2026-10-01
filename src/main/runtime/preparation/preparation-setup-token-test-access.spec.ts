import type { OrcaRuntimeService } from '../orca-runtime'

type SetupTokenInternals = { setupCompletionTokenByPtyId: Map<string, string> }

/** The runner nonce is private runtime state; tests print the marker the host would, so they read it. */
export function setupCompletionTokens(runtime: OrcaRuntimeService): Map<string, string> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService declares `protected setupCompletionTokenByPtyId = new Map<string, string>()` (orca-runtime-stop-requested-pty-ids.ts); only test code reads it, through this one seam.
  return (runtime as unknown as SetupTokenInternals).setupCompletionTokenByPtyId
}
