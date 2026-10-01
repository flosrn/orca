import type * as NodeFs from 'node:fs'
import type { PreparationArchiveDurability } from '../../../shared/preparation-output-read'

/** Joined capture bound, counted in UTF-8 bytes; reaching past it forfeits preservation. */
export const PREPARATION_OUTPUT_CAPTURE_LIMIT_BYTES = 16 * 1024 * 1024
export { PREPARATION_OUTPUT_READ_PAGE_MAX_BYTES } from '../../../shared/preparation-output-read'
export const PREPARATION_OUTPUT_ARCHIVE_VERSION = 1

export type PreparationOutputIncompleteness = 'missing-beginning' | 'sequence-gap' | 'overflow'

/**
 * One provider-ordered PTY chunk. Sequences are the runtime's cumulative provider character
 * offsets (`ptyOutputSequenceById`): `endSequence - startSequence` is the raw provider length,
 * which can differ from `data.length` when the runtime transformed the chunk.
 */
export type PreparationOutputChunk = {
  startSequence: number
  endSequence: number
  data: string
}

export type PreparationOutputSnapshot =
  | {
      authoritative: true
      text: string
      /** Provider sequence the text covers from 0; retirement compares it with the live sequence. */
      finalSequence: number
      byteLength: number
    }
  | {
      authoritative: false
      reason: PreparationOutputIncompleteness
      finalSequence: number | null
    }

/** Archive ownership facts; never environment values, launch tokens or setup command contents. */
export type PreparationArchiveIdentity = {
  preparationId: string
  /** Execution host id of the canonical worktree identity. */
  host: string
  /** `canonicalWorktreeIdentity` key; never a path. */
  worktreeKey: string
  instanceId: string
  incarnationId: string
}

export type { PreparationArchiveDurability } from '../../../shared/preparation-output-read'

/** `untracked`: no durable lifecycle record or bound preparation pane owns the capture. */
export type PreparationArchiveCommitRefusal =
  | PreparationOutputIncompleteness
  | 'storage-failed'
  | 'untracked'

export type PreparationArchiveCommit =
  | {
      committed: true
      archiveId: string
      finalSequence: number
      byteLength: number
      committedAt: number
      durability: PreparationArchiveDurability
      redactionApplied: boolean
    }
  | { committed: false; reason: PreparationArchiveCommitRefusal }

export type PreparationOutputArchiveSummary = PreparationArchiveIdentity & {
  archiveId: string
  committedAt: number
  byteLength: number
  finalSequence: number
  durability: PreparationArchiveDurability
  redactionApplied: boolean
}

export type PreparationArchivePage = {
  archiveId: string
  /** UTF-8 byte offset of `text`. */
  offset: number
  text: string
  /** Null once the page reaches the end of the archive. */
  nextOffset: number | null
  /** UTF-8 length of the whole archive text. */
  byteLength: number
  committedAt: number
  redactionApplied: boolean
}

/** Filesystem seam; the default is `node:fs`, and durability is only claimed for real fsync results. */
export type PreparationOutputFilesystem = Pick<
  typeof NodeFs,
  | 'mkdirSync'
  | 'writeFileSync'
  | 'openSync'
  | 'readSync'
  | 'fsyncSync'
  | 'fstatSync'
  | 'closeSync'
  | 'renameSync'
  | 'readFileSync'
  | 'readdirSync'
  | 'statSync'
  | 'chmodSync'
  | 'rmSync'
  | 'existsSync'
>

export type PreparationOutputErrorCode =
  | 'preparation_output_invalid_archive_id'
  | 'preparation_output_archive_not_found'
  | 'preparation_output_archive_unavailable'
  | 'preparation_output_read_limit'
  | 'preparation_output_read_offset'

export class PreparationOutputError extends Error {
  readonly code: PreparationOutputErrorCode

  constructor(code: PreparationOutputErrorCode) {
    super(code)
    this.name = 'PreparationOutputError'
    this.code = code
  }
}
