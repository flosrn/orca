// Why: automatic preparation retirement must see every input route (renderer IPC, runtime writes,
// mailbox delivery, agent prompts) as one monotonically advancing revision per PTY. Counted just
// before the provider write, so an input that reaches the process always moved it first.
const inputRevisionByPty = new Map<string, number>()

export function notePtyInput(ptyId: string): void {
  inputRevisionByPty.set(ptyId, (inputRevisionByPty.get(ptyId) ?? 0) + 1)
}

export function ptyInputRevision(ptyId: string): number {
  return inputRevisionByPty.get(ptyId) ?? 0
}

export function forgetPtyInputRevision(ptyId: string): void {
  inputRevisionByPty.delete(ptyId)
}
