/** Per-PTY activity revisions; idle retirement refuses when any moves while it inspects. */
export type LocalPtyActivity = { input: number; output: number; bind: number }

const activityById = new Map<string, LocalPtyActivity>()

export function noteLocalPtyActivity(id: string, kind: keyof LocalPtyActivity): void {
  let activity = activityById.get(id)
  if (!activity) {
    activity = { input: 0, output: 0, bind: 0 }
    activityById.set(id, activity)
  }
  activity[kind] += 1
}

export function readLocalPtyActivity(id: string): LocalPtyActivity {
  return { input: 0, output: 0, bind: 0, ...activityById.get(id) }
}

export function forgetLocalPtyActivity(id: string): void {
  activityById.delete(id)
}
