import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PREPARATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['preparation', 'output', 'list'],
    summary: 'List the archived output of a workspace preparation, newest first',
    usage: 'orca preparation output list --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [
      'Lists committed archives for the workspace generation on its execution host; never reads a live terminal.',
      'An empty list means no archive exists, which is distinct from an archive of empty output.'
    ],
    examples: [
      'orca preparation output list --worktree active',
      'orca preparation output list --worktree id:<repo-id>::<path> --json'
    ]
  },
  {
    path: ['preparation', 'output', 'read'],
    summary: 'Read archived preparation output by archive id',
    usage:
      'orca preparation output read --archive <id> [--offset <bytes>] [--limit <bytes>] [--all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'archive', 'offset', 'limit', 'all'],
    notes: [
      'Pages are bounded UTF-8 byte ranges of at most 65536 bytes; continue from nextOffset.',
      '--all follows nextOffset to the end. Human output strips terminal escape sequences.',
      'Reading never reopens a terminal or reruns setup.'
    ],
    examples: [
      'orca preparation output read --archive <id> --all',
      'orca preparation output read --archive <id> --offset 65536 --limit 65536 --json'
    ]
  }
]
