import { fsyncPath } from './preparation-output-archive-file'
import { basename, dirname, join } from 'node:path'
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  supportsPosixFileModes
} from '../../daemon/daemon-private-file-modes'
import type {
  PreparationArchiveDurability,
  PreparationOutputFilesystem,
  PreparationOutputIncompleteness
} from './preparation-output-contracts'

const LIFECYCLE_VERSION = 1

export type PreparationLifecyclePane = { ptyId: string; incarnationId: string }

export type PreparationLifecycleState = 'observing' | 'retiring' | 'retained' | 'retired'

export type LifecycleReconcileOutcome =
  | { kind: 'retired' }
  | { kind: 'observing' }
  | {
      kind: 'retained'
      reason: PreparationRetentionReason
      capture?: PreparationOutputIncompleteness
    }

export type PreparationRetentionReason =
  | 'capture-incomplete'
  | 'input-after-snapshot'
  | 'ownership-changed'
  | 'incarnation-exited'
  | 'unbound'

export type PreparationLifecycleArchive = {
  archiveId: string
  finalSequence: number
  inputRevision: number
  durability: PreparationArchiveDurability
}

/** Mutable lifecycle facts; archive bytes live separately in immutable files. */
export type PreparationLifecycleRecord = {
  preparationId: string
  host: string
  worktreeKey: string
  instanceId: string
  preparation: PreparationLifecyclePane | null
  agent: PreparationLifecyclePane | null
  state: PreparationLifecycleState
  retainedReason: PreparationRetentionReason | null
  capture: 'complete' | PreparationOutputIncompleteness
  archives: PreparationLifecycleArchive[]
  /** The only archive whose coverage currently authorizes closure; null means none does. */
  closureArchiveId: string | null
  /** Exact incarnation a close was issued against; kept until reconciled. */
  pendingClose: (PreparationLifecyclePane & { archiveId: string }) | null
}

export type PreparationDeletionObligation = { host: string; instanceId: string; recordedAt: number }

/** On-disk shape of the lifecycle facts file. */
export type LifecycleFile = {
  version: typeof LIFECYCLE_VERSION
  records: PreparationLifecycleRecord[]
  deletionObligations: PreparationDeletionObligation[]
}

export class PreparationLifecycleError extends Error {
  readonly code: 'preparation_lifecycle_unreadable' | 'preparation_lifecycle_conflict'

  constructor(code: 'preparation_lifecycle_unreadable' | 'preparation_lifecycle_conflict') {
    super(code)
    this.name = 'PreparationLifecycleError'
    this.code = code
  }
}
export function newLifecycleRecord(identity: {
  preparationId: string
  host: string
  worktreeKey: string
  instanceId: string
}): PreparationLifecycleRecord {
  return {
    ...identity,
    preparation: null,
    agent: null,
    state: 'observing',
    retainedReason: null,
    capture: 'complete',
    archives: [],
    closureArchiveId: null,
    pendingClose: null
  }
}

/** The only archive whose coverage currently authorizes closure. */
export function closureArchiveOf(
  record: PreparationLifecycleRecord
): PreparationLifecycleArchive | null {
  return record.archives.find((entry) => entry.archiveId === record.closureArchiveId) ?? null
}

export function emptyLifecycleFile(): LifecycleFile {
  return { version: LIFECYCLE_VERSION, records: [], deletionObligations: [] }
}

/** Unreadable facts grant no authority and are never silently reset. */
export function readLifecycleFile(
  fs: PreparationOutputFilesystem,
  filePath: string
): LifecycleFile {
  if (!fs.existsSync(filePath)) {
    return emptyLifecycleFile()
  }
  try {
    const parsed = parseLifecycleFile(fs.readFileSync(filePath, 'utf8'))
    if (parsed) {
      return parsed
    }
  } catch {
    // Fall through to the typed refusal.
  }
  throw new PreparationLifecycleError('preparation_lifecycle_unreadable')
}

/** Private temp write, file fsync, rename, then best-effort directory fsync. */
export function writeLifecycleFile(
  fs: PreparationOutputFilesystem,
  filePath: string,
  file: LifecycleFile
): void {
  const directory = dirname(filePath)
  const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.tmp`)
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
  if (supportsPosixFileModes()) {
    fs.chmodSync(directory, PRIVATE_DIR_MODE)
  }
  let renamed = false
  try {
    fs.writeFileSync(tempPath, JSON.stringify(file), { mode: PRIVATE_FILE_MODE })
    if (supportsPosixFileModes()) {
      fs.chmodSync(tempPath, PRIVATE_FILE_MODE)
    }
    fsyncPath(fs, tempPath, 'r+')
    fs.renameSync(tempPath, filePath)
    renamed = true
  } finally {
    if (!renamed) {
      fs.rmSync(tempPath, { force: true })
    }
  }
  try {
    fsyncPath(fs, directory, 'r')
  } catch {
    // Unsupported directory sync: the fact is written but only as durable as the platform allows.
  }
}
export function cloneRecord(record: PreparationLifecycleRecord): PreparationLifecycleRecord {
  return {
    ...record,
    preparation: record.preparation ? { ...record.preparation } : null,
    agent: record.agent ? { ...record.agent } : null,
    archives: record.archives.map((entry) => ({ ...entry })),
    pendingClose: record.pendingClose ? { ...record.pendingClose } : null
  }
}

export function cloneFile(file: LifecycleFile): LifecycleFile {
  return {
    version: LIFECYCLE_VERSION,
    records: file.records.map(cloneRecord),
    deletionObligations: file.deletionObligations.map((entry) => ({ ...entry }))
  }
}

function parseLifecycleFile(raw: string): LifecycleFile | null {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate: { version?: unknown; records?: unknown; deletionObligations?: unknown } = value
  if (
    candidate.version !== LIFECYCLE_VERSION ||
    !Array.isArray(candidate.records) ||
    !Array.isArray(candidate.deletionObligations) ||
    !candidate.records.every(isLifecycleRecord) ||
    !candidate.deletionObligations.every(isDeletionObligation)
  ) {
    return null
  }
  return cloneFile({
    version: LIFECYCLE_VERSION,
    records: candidate.records,
    deletionObligations: candidate.deletionObligations
  })
}

function isLifecycleRecord(value: unknown): value is PreparationLifecycleRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record: Partial<Record<keyof PreparationLifecycleRecord, unknown>> = value
  return (
    typeof record.preparationId === 'string' &&
    typeof record.host === 'string' &&
    typeof record.worktreeKey === 'string' &&
    typeof record.instanceId === 'string' &&
    (record.state === 'observing' ||
      record.state === 'retiring' ||
      record.state === 'retained' ||
      record.state === 'retired') &&
    Array.isArray(record.archives) &&
    (record.closureArchiveId === null || typeof record.closureArchiveId === 'string')
  )
}

function isDeletionObligation(value: unknown): value is PreparationDeletionObligation {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const entry: Partial<Record<keyof PreparationDeletionObligation, unknown>> = value
  return typeof entry.host === 'string' && typeof entry.instanceId === 'string'
}
