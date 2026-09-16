import type { MessageRow } from '../../../../orchestration/types'

// Why: read/sequence and the pointer_* and sender_pane_key columns are delivery plumbing
// the runtime owns. Publishing them made a caller treat internal state as mailbox truth.
// Consumers need the attribution verdict, not the private pane identity. Derive it
// from the stored runtime witness only, never from sender-controlled payload fields.
const INTERNAL_MESSAGE_COLUMNS = [
  'read',
  'sequence',
  'sender_pane_key',
  'pointer_enter_pending',
  'pointer_pty_id',
  'pointer_process_incarnation'
] as const

export type MailboxMessageReceipt = Omit<MessageRow, (typeof INTERNAL_MESSAGE_COLUMNS)[number]> & {
  sender_attribution: 'pane' | 'unattributed'
}

export function exposeMessage(message: MessageRow): MailboxMessageReceipt {
  return exposeMessages([message])[0]!
}

export function exposeMessages(messages: MessageRow[]): MailboxMessageReceipt[] {
  return messages.map((message) => {
    const exposed: Partial<MessageRow> & Pick<MailboxMessageReceipt, 'sender_attribution'> = {
      ...message,
      sender_attribution: message.sender_pane_key ? 'pane' : 'unattributed'
    }
    for (const column of INTERNAL_MESSAGE_COLUMNS) {
      delete exposed[column]
    }
    return exposed as MailboxMessageReceipt
  })
}
