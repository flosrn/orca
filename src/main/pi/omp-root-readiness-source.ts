// Why: preparation cleanup needs positive evidence that the pane's root OMP session took over;
// every later post from this runner carries it until a session switch clears it.
export function getOmpRootReadinessHandlerSourceLines(): string[] {
  return [
    '  let localReadiness = null',
    '  function post(hookEventName, extra = {}) {',
    '    emitStatus(hookEventName, localReadiness ? { ...localReadiness, ...extra } : extra)',
    '  }',
    '  function captureRootReadiness(ctx) {',
    '    if (!isOmpRuntime()) return false',
    '    const kind = ctx && ctx.agent && ctx.agent.kind',
    '    if (kind !== "main") return false',
    '    const manager = ctx && ctx.sessionManager',
    '    if (!manager || typeof manager !== "object" || typeof manager.getSessionId !== "function") return false',
    '    const id = manager.getSessionId()',
    '    if (typeof id !== "string" || !id) return false',
    '    localReadiness = { root_session_ready: true, root_session_id: id, status_owner_module: statusOwnerModule() }',
    '    return true',
    '  }'
  ]
}
