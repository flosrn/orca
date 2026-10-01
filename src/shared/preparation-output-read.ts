import {
  TERMINAL_CONTROL_CHARACTER_PATTERN,
  stripAnsiEscapeSequences
} from './ansi-escape-sequences'

/** Wire contract for reading committed preparation-output archives (RPC, CLI and renderer). */

export const PREPARATION_OUTPUT_READ_PAGE_MAX_BYTES = 64 * 1024

export const PREPARATION_OUTPUT_ERROR_CODES = [
  'preparation_output_invalid_archive_id',
  'preparation_output_archive_not_found',
  'preparation_output_archive_unavailable',
  'preparation_output_read_limit',
  'preparation_output_read_offset',
  'preparation_output_worktree_identity_unavailable',
  'preparation_output_storage_unavailable'
] as const

/** `unestablished`: published and readable, but the rename's durability is unproven, so it authorizes no destruction. */
export type PreparationArchiveDurability = 'established' | 'unestablished'

export type PreparationOutputArchiveSummaryWire = {
  archiveId: string
  preparationId: string
  host: string
  worktreeKey: string
  instanceId: string
  incarnationId: string
  committedAt: number
  byteLength: number
  finalSequence: number
  durability: PreparationArchiveDurability
  redactionApplied: boolean
}

export type PreparationOutputListResult = {
  worktree: { worktreeId: string; hostId: string; instanceId: string; worktreeKey: string }
  /** Newest first; empty means no archive exists, never empty output. */
  archives: PreparationOutputArchiveSummaryWire[]
}

export type PreparationOutputPage = {
  archiveId: string
  /** UTF-8 byte offset of `text`. */
  offset: number
  text: string
  nextOffset: number | null
  byteLength: number
  committedAt: number
  redactionApplied: boolean
}

/** Archived output as inert text: escapes and control bytes removed, carriage returns as line breaks. */
export function toInertPreparationText(text: string): string {
  return stripAnsiEscapeSequences(text)
    .replace(/\r\n?/g, '\n')
    .replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
}
