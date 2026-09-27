import { runProcessSync } from '../../shared/child-process/run-process'

// Why: the whole-host read runs only after the TTY-scoped one failed, and it is the last thing
// standing between a closed pane and a surviving agent process, so it gets the longer budget.
const DESCENDANT_TABLE_TIMEOUT_MS = 3_000
const DESCENDANT_TABLE_MAX_BYTES = 1024 * 1024

type DescendantRow = {
  pid: number
  ppid: number
  pgid: number
}

/** Whole-host `pid ppid pgid` table, read only when the TTY-scoped table cannot answer. */
export function readPosixDescendantProcessTable(): string {
  const result = runProcessSync({
    program: 'ps',
    args: ['-axo', 'pid=,ppid=,pgid='],
    env: { ...process.env, LC_ALL: 'C' },
    timeoutMs: DESCENDANT_TABLE_TIMEOUT_MS,
    maxOutputBytes: DESCENDANT_TABLE_MAX_BYTES
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('PTY descendant process table is unavailable')
  }
  return result.stdout
}

/**
 * Every process group under one PTY leader, proven by parentage instead of TTY: the leader's
 * own group last, so its children are dead before it is. Null when the leader is absent from the
 * table or when Orca itself sits in the tree — never group-signal a group Orca belongs to.
 */
export function getPosixDescendantProcessGroups(
  output: string,
  rootPid: number,
  currentPid = process.pid
): number[] | null {
  const rows: DescendantRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line)
    if (match) {
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) })
    }
  }
  const root = rows.find((row) => row.pid === rootPid)
  if (!root || root.pgid <= 1) {
    return null
  }
  const childrenByParent = new Map<number, DescendantRow[]>()
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid)
    if (siblings) {
      siblings.push(row)
    } else {
      childrenByParent.set(row.ppid, [row])
    }
  }
  const tree = [root]
  for (let index = 0; index < tree.length; index++) {
    for (const child of childrenByParent.get(tree[index].pid) ?? []) {
      if (!tree.includes(child)) {
        tree.push(child)
      }
    }
  }
  if (tree.some((row) => row.pid === currentPid)) {
    return null
  }
  const groups = new Set(tree.filter((row) => row.pgid > 1).map((row) => row.pgid))
  groups.delete(root.pgid)
  return [...groups].sort((left, right) => left - right).concat(root.pgid)
}
