import type * as dependencies from './orca-runtime-create-terminal-dependencies'
import { BACKGROUND_TERMINAL_SPAWN_FLAGS } from './orca-runtime-create-terminal-dependencies'

type LaunchOptions = dependencies.TerminalCreateOptions
type PtyController = dependencies.RuntimePtyController
type SpawnArgs = Parameters<NonNullable<PtyController['spawn']>>[0]

export function backgroundTerminalSpawnArgs(input: {
  launchOpts: LaunchOptions
  cwd: string
  command: string | undefined
  env: Record<string, string>
  envToDelete: string[] | undefined
  workspace: { id: string; connectionId?: string | null }
  preAllocatedHandle: string
  tabId: string
  leafId: string
  terminalColorQueryReplies: SpawnArgs['terminalColorQueryReplies']
  preparation: LaunchOptions['preparation']
  reportPtySpawnCommitted: () => void
  adoptedBeforeLaunch: SpawnArgs['adoptedStablePane']
}): SpawnArgs {
  const { launchOpts } = input
  return {
    cols: 120,
    rows: 40,
    cwd: input.cwd,
    command: input.command,
    launchAgent: launchOpts.launchAgent,
    commandDelivery: 'provider',
    startupCommandDelivery: launchOpts.startupCommandDelivery,
    env: input.env,
    envToDelete: input.envToDelete,
    resumeProviderSession: launchOpts.resumeProviderSession,
    telemetry: launchOpts.telemetry,
    connectionId: input.workspace.connectionId,
    worktreeId: input.workspace.id,
    preAllocatedHandle: input.preAllocatedHandle,
    tabId: input.tabId,
    leafId: input.leafId,
    ...(launchOpts.shellOverride ? { shellOverride: launchOpts.shellOverride } : {}),
    ...(input.terminalColorQueryReplies
      ? { terminalColorQueryReplies: input.terminalColorQueryReplies }
      : {}),
    terminalKittyKeyboardProtocol: launchOpts.terminalKittyKeyboardProtocol,
    ...(launchOpts.agentSessionClaim
      ? {
          agentSessionEnsure: {
            claim: launchOpts.agentSessionClaim,
            surface: {
              worktreeId: input.workspace.id,
              tabId: input.tabId,
              leafId: input.leafId,
              terminalHandle: input.preAllocatedHandle
            }
          }
        }
      : {}),
    ...(launchOpts.agentSessionCreateOperationId
      ? { agentSessionCreateOperationId: launchOpts.agentSessionCreateOperationId }
      : {}),
    ...(launchOpts.signal ? { signal: launchOpts.signal } : {}),
    ...(input.preparation ? { preparation: input.preparation } : {}),
    ...(launchOpts.onPtySpawnCommitted
      ? { onPtySpawnCommitted: input.reportPtySpawnCommitted }
      : {}),
    ...(input.adoptedBeforeLaunch ? { adoptedStablePane: input.adoptedBeforeLaunch } : {}),
    ...(launchOpts.sessionId ? { sessionId: launchOpts.sessionId } : {}),
    ...(!input.adoptedBeforeLaunch && launchOpts.isNewSession ? { isNewSession: true } : {}),
    ...BACKGROUND_TERMINAL_SPAWN_FLAGS
  }
}
