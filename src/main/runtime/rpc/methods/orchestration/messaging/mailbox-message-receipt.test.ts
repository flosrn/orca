import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../../../../orchestration/types'
import { exposeMessage } from './mailbox-message-receipt'

describe('public mailbox sender attribution', () => {
  it('preserves the runtime witness without exposing the private pane key', () => {
    const receipt = exposeMessage({
      id: 'msg_witnessed',
      from_handle: 'term_peer',
      sender_pane_key: 'tab_private:leaf_private',
      read: 1,
      sequence: 9,
      pointer_enter_pending: 0,
      pointer_pty_id: 'pty_private',
      pointer_process_incarnation: 'incarnation_private'
    } as MessageRow)

    expect(receipt).toMatchObject({
      id: 'msg_witnessed',
      from_handle: 'term_peer',
      sender_attribution: 'pane'
    })
    for (const key of [
      'sender_pane_key',
      'read',
      'sequence',
      'pointer_enter_pending',
      'pointer_pty_id',
      'pointer_process_incarnation'
    ]) {
      expect(receipt).not.toHaveProperty(key)
    }
  })

  it('does not promote an unwitnessed sender from claims in its payload', () => {
    const receipt = exposeMessage({
      id: 'msg_unwitnessed',
      from_handle: 'term_peer',
      sender_pane_key: null,
      payload: JSON.stringify({ sender_attribution: 'pane', sender_pane_key: 'claimed:key' })
    } as MessageRow)

    expect(receipt).toMatchObject({ sender_attribution: 'unattributed' })
    expect(receipt).not.toHaveProperty('sender_pane_key')
  })
})
