import { describe, expect, it } from 'vitest'
import type { DispatchContextRow } from './orchestration/types'
import {
  isDispatchSessionProvenSuperseded,
  refuseObsoleteDispatchSessionRestore,
  type DispatchObsoleteRestoreLookup
} from './dispatch-obsolete-session-restore'

const HANDLE = 'term_old'
const PANE = 'tab_old:33333333-3333-4333-8333-333333333333'
const TASK = 'task_one'
const OTHER_TASK = 'task_two'

function row(id: string, taskId: string): DispatchContextRow {
  return { id, task_id: taskId } as DispatchContextRow
}

function db(opts: {
  latest?: DispatchContextRow
  active?: DispatchContextRow
  newestForTask?: Record<string, DispatchContextRow>
  throwOnRead?: boolean
}): DispatchObsoleteRestoreLookup {
  return {
    getLatestDispatchForTerminal() {
      if (opts.throwOnRead) {
        throw new Error('db_unreadable')
      }
      return opts.latest
    },
    getActiveDispatchForTerminal() {
      if (opts.throwOnRead) {
        throw new Error('db_unreadable')
      }
      return opts.active
    },
    getDispatchContext(taskId) {
      if (opts.throwOnRead) {
        throw new Error('db_unreadable')
      }
      return opts.newestForTask?.[taskId]
    }
  }
}

describe('obsolete dispatch session restore', () => {
  it('refuses only when a newer dispatch exists for the same task', () => {
    expect(
      isDispatchSessionProvenSuperseded(
        db({
          latest: row('ctx_old', TASK),
          newestForTask: { [TASK]: row('ctx_new', TASK) }
        }),
        HANDLE,
        PANE
      )
    ).toBe(true)
  })

  it('allows a completed dispatch that is still the task latest', () => {
    const latest = row('ctx_old', TASK)
    expect(
      isDispatchSessionProvenSuperseded(
        db({ latest, newestForTask: { [TASK]: latest } }),
        HANDLE,
        PANE
      )
    ).toBe(false)
  })

  it('allows a pane with no dispatch row — operator shell, not a worker', () => {
    expect(isDispatchSessionProvenSuperseded(db({}), HANDLE, PANE)).toBe(false)
  })

  it('allows a newer dispatch on a different task — supersession is not proven', () => {
    // Honest gap: replacement under another task is not this predicate. Do not
    // widen the match; distinct workers sharing a worktree must stay restorable.
    expect(
      isDispatchSessionProvenSuperseded(
        db({
          latest: row('ctx_old', TASK),
          newestForTask: {
            [TASK]: row('ctx_old', TASK),
            [OTHER_TASK]: row('ctx_other', OTHER_TASK)
          }
        }),
        HANDLE,
        PANE
      )
    ).toBe(false)
  })

  it('falls back to the pane-keyed active lookup when the handle has no latest row', () => {
    expect(
      isDispatchSessionProvenSuperseded(
        db({
          active: row('ctx_old', TASK),
          newestForTask: { [TASK]: row('ctx_new', TASK) }
        }),
        HANDLE,
        PANE
      )
    ).toBe(true)
  })

  it('allows recover when there is no orchestration DB', () => {
    expect(() => refuseObsoleteDispatchSessionRestore(null, HANDLE, PANE)).not.toThrow()
  })

  it('refuses when the dispatch lookup throws — unknown is not no-dispatch', () => {
    expect(() =>
      refuseObsoleteDispatchSessionRestore(db({ throwOnRead: true }), HANDLE, PANE)
    ).toThrow('terminal_not_recoverable')
  })
})
