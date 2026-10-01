import { EventEmitter } from 'node:events'
import { createContext, runInContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { vi } from 'vitest'

import { getPiAgentStatusExtensionSource } from './agent-status-extension-source'

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

type FakeCurlChild = {
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

const BASE_ENV = {
  ORCA_PANE_KEY: 'pane-1',
  ORCA_AGENT_LAUNCH_TOKEN: 'launch-1',
  ORCA_TAB_ID: 'tab-1',
  ORCA_WORKTREE_ID: 'tree-1',
  ORCA_AGENT_HOOK_PORT: '4321',
  ORCA_AGENT_HOOK_TOKEN: 'token-1',
  ORCA_AGENT_HOOK_ENV: 'env-1',
  ORCA_AGENT_HOOK_VERSION: '1.2.3'
} satisfies Record<string, string>

// Why: ownership keys on process.pid, so reload and child-process tests need
// stable, distinct identities.
export const AGENT_STATUS_EXTENSION_SELF_PID = 4242

// Distinct from the resolved path so a raw __filename echo is not provenance.
const STATUS_MODULE_FILENAME = '/tmp/orca-status-link/orca-agent-status.ts'
const STATUS_MODULE_REALPATH = '/opt/orca/extensions/orca-agent-status.ts'

export function resolveStatusModule(filename: string): string {
  if (filename === STATUS_MODULE_FILENAME) {
    return STATUS_MODULE_REALPATH
  }
  return `/resolved${filename}`
}

function isolateEvaluatedModule(code: string): string {
  return `(function (exports, module, require, __filename, __dirname) {\n${code}\n})(exports, module, require, __filename, __dirname)\n`
}

export function createAgentStatusExtensionHarness(args: {
  kind: 'pi' | 'omp' | 'prime-agent'
  killImpl?: (pid: number, signal: number) => void
  env?: Record<string, string | undefined>
  pid?: number
  title?: string
  argv?: readonly string[]
  existsSync?: (path: string) => boolean
  readFileSync?: (path: string, encoding: string) => string
  statSync?: (path: string) => { mtimeMs: number; size: number; ino: number }
  curlExitCode?: number | null
  fetchImpl?: (...params: Parameters<typeof fetch>) => Promise<unknown>
  deferRegistration?: boolean
}): AgentStatusExtensionHarness {
  const fetchMock = vi.fn(
    args.fetchImpl ??
      (async () => ({
        ok: true
      }))
  )

  const spawnedChildren: FakeCurlChild[] = []
  const spawnMock = vi.fn(() => {
    const emitter = new EventEmitter()
    const child: FakeCurlChild = {
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(() => emitter.emit('close', null)),
      on: vi.fn(emitter.on.bind(emitter)),
      stdin: {
        on: vi.fn(),
        end: vi.fn()
      }
    }
    spawnedChildren.push(child)
    if (args.curlExitCode !== null) {
      void Promise.resolve().then(() => emitter.emit('close', args.curlExitCode ?? 0))
    }
    return child
  })

  const fsMock = {
    existsSync: vi.fn(args.existsSync ?? (() => false)),
    statSync: vi.fn(
      args.statSync ??
        ((path: string) => {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        })
    ),
    readFileSync: vi.fn(
      args.readFileSync ??
        ((path: string) => {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        })
    ),
    realpathSync: vi.fn((path: string) => resolveStatusModule(path))
  }

  const module: {
    exports: {
      default?: (pi: {
        on: (name: string, handler: HookHandler) => void
        registerCommand: (
          name: string,
          command: { handler: (args: string, context: HookContext) => Promise<void> }
        ) => void
        setModel: (model: unknown) => Promise<boolean>
        events?: EventEmitter
      }) => void
    }
  } = { exports: {} }
  const requireMock = vi.fn((specifier: string) => {
    if (specifier === 'fs') {
      return fsMock
    }
    if (specifier === 'child_process') {
      return { spawn: spawnMock }
    }
    throw new Error(`unexpected require(${specifier})`)
  })

  const killMock = vi.fn(args.killImpl ?? (() => undefined))
  const processMock = {
    kill: killMock,
    env: {
      ...BASE_ENV,
      ...(args.kind === 'prime-agent' ? { PRIME_AGENT_INTERNAL_DAEMON_WORKER: '1' } : {}),
      ...args.env
    },
    pid: args.pid ?? AGENT_STATUS_EXTENSION_SELF_PID,
    title: args.title ?? 'node',
    argv: args.argv ?? ['node', '/usr/bin/orca']
  }

  const context: Record<string, unknown> = {
    module,
    exports: module.exports,
    require: requireMock,
    process: processMock,
    fetch: fetchMock,
    console: {
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn()
    },
    Promise,
    Buffer,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    __filename: STATUS_MODULE_FILENAME,
    __dirname: '/tmp/orca-status-link'
  }
  context.globalThis = context

  const source = getPiAgentStatusExtensionSource(args.kind)
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  }).outputText
  const vmContext = createContext(context)
  runInContext(isolateEvaluatedModule(output), vmContext)

  const register = module.exports.default
  if (!register) {
    throw new Error('expected default export from generated source')
  }

  const handlers: Record<string, HookHandler> = {}
  const listeners = new Map<string, HookHandler[]>()
  const piEvents = new EventEmitter()
  const commands: AgentStatusExtensionHarness['commands'] = {}
  const setModelMock = vi.fn(async (_model: unknown) => true)
  const registerInto = (target: Record<string, HookHandler>): void => {
    register({
      registerCommand: (name, command) => {
        commands[name] = command
      },
      setModel: setModelMock,
      events: piEvents,
      on(name: string, handler: HookHandler) {
        const list = listeners.get(name) ?? []
        list.push(handler)
        listeners.set(name, list)
        target[name] = handler
      }
    })
  }
  if (!args.deferRegistration) {
    registerInto(handlers)
  }

  const bindPeer = (peerSource: string, filename: string) => {
    const previousName = context.__filename
    const previousDir = context.__dirname
    const previousModule = context.module
    const previousExports = context.exports
    const peerModule: { exports: { default?: (pi: unknown) => void } } = { exports: {} }
    context.__filename = filename
    context.__dirname = filename.slice(0, filename.lastIndexOf('/'))
    context.module = peerModule
    context.exports = peerModule.exports
    runInContext(
      isolateEvaluatedModule(
        ts.transpileModule(peerSource, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
        }).outputText
      ),
      vmContext
    )
    context.__filename = previousName
    context.__dirname = previousDir
    context.module = previousModule
    context.exports = previousExports
    const peerRegister = peerModule.exports.default
    if (!peerRegister) {
      throw new Error('peer status extension missing default export')
    }
    const peerHandlers: Record<string, HookHandler> = {}
    const peerListeners = new Map<string, HookHandler[]>()
    peerRegister({
      registerCommand() {},
      setModel: setModelMock,
      events: new EventEmitter(),
      on(name: string, handler: HookHandler) {
        const list = peerListeners.get(name) ?? []
        list.push(handler)
        peerListeners.set(name, list)
        peerHandlers[name] = handler
      }
    })
    return {
      handlers: peerHandlers,
      statusOwnerModule: resolveStatusModule(filename),
      callHook: async (name: string, event?: unknown, hookContext?: HookContext) => {
        for (const handler of peerListeners.get(name) ?? []) {
          await handler(event, hookContext)
        }
      }
    }
  }

  return {
    setModelMock,
    commands,
    fetchMock,
    killMock,
    spawnMock,
    spawnedChildren,
    fsMock,
    statusOwnerModule: STATUS_MODULE_REALPATH,
    bindPeer,
    activate: () => {
      registerInto(handlers)
    },
    handlers,
    processEnv: processMock.env,
    callHook: async (name, event, hookContext) => {
      for (const handler of listeners.get(name) ?? []) {
        await handler(event, hookContext)
      }
    },
    emitPiEvent: (name, event) => {
      piEvents.emit(name, event)
    },
    piEventListenerCount: (name) => piEvents.listenerCount(name),
    reload: () => {
      listeners.clear()
      for (const key of Object.keys(handlers)) {
        delete handlers[key]
      }
      registerInto(handlers)
    }
  }
}
