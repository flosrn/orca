import type { vi } from 'vitest'

export type HookContext = {
  hasUI?: boolean
  ui?: { setEditorText?: (text: string) => void; notify?: (message: string, level: string) => void }
  isIdle?: () => boolean
  model?: { provider?: unknown; id?: unknown } | null
  modelRegistry?: { getAvailable: () => { provider: string; id: string }[] }
  sessionManager?: {
    getSessionId?: () => unknown
    getSessionFile?: () => unknown
    getHeader?: () => unknown
  }
}

export type HookHandler = (event?: unknown, context?: HookContext) => Promise<void> | void

export type FakeCurlChild = {
  kill: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => boolean
  on: ReturnType<typeof vi.fn>
  stdin: {
    on: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }
}

export type AgentStatusExtensionHarness = {
  setModelMock: ReturnType<typeof vi.fn>
  commands: Record<string, { handler: (args: string, context: HookContext) => Promise<void> }>
  killMock: ReturnType<typeof vi.fn>
  fetchMock: ReturnType<typeof vi.fn>
  spawnMock: ReturnType<typeof vi.fn>
  spawnedChildren: FakeCurlChild[]
  fsMock: {
    existsSync: ReturnType<typeof vi.fn>
    readFileSync: ReturnType<typeof vi.fn>
    statSync: ReturnType<typeof vi.fn>
    realpathSync: ReturnType<typeof vi.fn>
  }
  statusOwnerModule: string
  bindPeer: (
    source: string,
    filename: string
  ) => {
    handlers: Record<string, HookHandler>
    callHook: (name: string, event?: unknown, context?: HookContext) => Promise<void>
    statusOwnerModule: string
  }
  activate: () => void
  handlers: Record<string, HookHandler>
  processEnv: Record<string, string | undefined>
  callHook: (name: string, event?: unknown, context?: HookContext) => Promise<void>
  emitPiEvent: (name: string, event: unknown) => void
  piEventListenerCount: (name: string) => number
  // Re-invoke the extension factory in the same process (as Pi does on an
  // in-process extension reload), swapping in the freshly registered handlers.
  reload: () => void
}
