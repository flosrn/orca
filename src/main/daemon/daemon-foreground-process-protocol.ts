export type GetForegroundProcessRequest = {
  id: string
  type: 'getForegroundProcess'
  payload: {
    sessionId: string
  }
}

export type ConfirmForegroundProcessRequest = Omit<GetForegroundProcessRequest, 'type'> & {
  type: 'confirmForegroundProcess'
}

export type ConfirmShellForegroundRequest = Omit<GetForegroundProcessRequest, 'type'> & {
  type: 'confirmShellForeground'
}

export type InspectProcessRequest = Omit<GetForegroundProcessRequest, 'type'> & {
  type: 'inspectProcess'
  payload: GetForegroundProcessRequest['payload'] & {
    expectedIncarnationId?: string
    /** Optional; a daemon that predates it answers with the full capture as it always did. */
    steadyState?: boolean
  }
}

/** v37+: the daemon stops the session only when it proves the exact incarnation idle. */
export type RetireIdleRequest = Omit<GetForegroundProcessRequest, 'type'> & {
  type: 'retireIdle'
  payload: GetForegroundProcessRequest['payload'] & {
    expectedIncarnationId: string
    expectedOutputChars?: number
  }
}

/** Every request that inspects, or conditionally stops, a session's process tree. */
export type DaemonProcessRequest =
  | GetForegroundProcessRequest
  | InspectProcessRequest
  | ConfirmForegroundProcessRequest
  | ConfirmShellForegroundRequest
  | RetireIdleRequest
