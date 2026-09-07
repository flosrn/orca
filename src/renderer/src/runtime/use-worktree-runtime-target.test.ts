// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import { useWorktreeRuntimeTarget } from './use-worktree-runtime-target'

const initialState = useAppStore.getInitialState()
const WORKTREE_ID = 'repo-1::/tmp/repo-1'

describe('useWorktreeRuntimeTarget', () => {
  beforeEach(() => {
    useAppStore.setState(
      {
        ...initialState,
        settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: null },
        repos: [],
        worktreesByRepo: {},
        activeWorktreeId: WORKTREE_ID
      },
      true
    )
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  // Why: the store subscription is real here. A selector that allocates the
  // target per snapshot read never settles and throws React #185 in this test.
  it('keeps the target identity stable across unrelated store writes', () => {
    const hook = renderHook(() => useWorktreeRuntimeTarget(WORKTREE_ID))
    const first = hook.result.current

    expect(first).toEqual({ kind: 'local' })
    act(() => {
      for (let index = 0; index < 100; index += 1) {
        useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
      }
    })
    hook.rerender()

    expect(hook.result.current).toBe(first)
  })

  it('follows the owning host when the worktree moves to a runtime', () => {
    const hook = renderHook(() => useWorktreeRuntimeTarget(WORKTREE_ID))

    act(() => {
      useAppStore.setState({
        activeWorkspaceExecutionHostId: 'runtime:env-1'
      })
    })

    expect(hook.result.current).toEqual({ kind: 'environment', environmentId: 'env-1' })
  })
})
