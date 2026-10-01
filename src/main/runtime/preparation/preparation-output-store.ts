import { randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  supportsPosixFileModes
} from '../../daemon/daemon-private-file-modes'
import {
  ARCHIVE_ID_PATTERN,
  ARCHIVE_SUFFIX,
  TEMP_PREFIX,
  TEMP_SUFFIX,
  archiveIdFromName,
  fsyncPath,
  openArchiveFile,
  readArchivePage,
  renderArchive,
  type ArchiveHeader
} from './preparation-output-archive-file'
import {
  PREPARATION_OUTPUT_READ_PAGE_MAX_BYTES,
  PreparationOutputError,
  type PreparationArchiveCommit,
  type PreparationArchiveDurability,
  type PreparationArchiveIdentity,
  type PreparationArchivePage,
  type PreparationOutputArchiveSummary,
  type PreparationOutputFilesystem,
  type PreparationOutputSnapshot
} from './preparation-output-contracts'

/**
 * Immutable, redacted preparation archives under private runtime profile storage.
 * Each archive is one file: a JSON header line, then the normalized (escapes, control bytes and
 * carriage returns removed), redacted UTF-8 text. It is published by
 * private temp write, file fsync, no-overwrite rename and directory fsync, and never rewritten.
 */
export class PreparationOutputStore {
  private readonly root: string
  private readonly fs: PreparationOutputFilesystem
  private readonly now: () => number
  private readonly isGenerationRevoked: (host: string, instanceId: string) => boolean
  // Why in memory: after a restart the file's presence is itself the persistence proof.
  private readonly unestablished = new Set<string>()

  constructor(options: {
    root: string
    filesystem?: PreparationOutputFilesystem
    now?: () => number
    /** Deleted generations whose purge failed stay unreadable until recovery removes them. */
    isGenerationRevoked?: (host: string, instanceId: string) => boolean
  }) {
    this.root = options.root
    this.fs = options.filesystem ?? nodeFs
    this.now = options.now ?? Date.now
    this.isGenerationRevoked = options.isGenerationRevoked ?? (() => false)
  }

  commit(args: {
    identity: PreparationArchiveIdentity
    snapshot: PreparationOutputSnapshot
  }): PreparationArchiveCommit {
    const { identity, snapshot } = args
    if (!snapshot.authoritative) {
      return { committed: false, reason: snapshot.reason }
    }
    const { header, payload } = renderArchive({
      archiveId: randomUUID(),
      identity,
      text: snapshot.text,
      finalSequence: snapshot.finalSequence,
      committedAt: this.now()
    })
    const { archiveId } = header
    const finalPath = this.archivePath(archiveId)
    const tempPath = join(this.root, `${TEMP_PREFIX}${archiveId}${TEMP_SUFFIX}`)
    let published = false
    try {
      this.ensurePrivateRoot()
      this.fs.writeFileSync(tempPath, payload, { mode: PRIVATE_FILE_MODE, flag: 'wx' })
      if (supportsPosixFileModes()) {
        this.fs.chmodSync(tempPath, PRIVATE_FILE_MODE)
      }
      fsyncPath(this.fs, tempPath, 'r+')
      if (this.fs.existsSync(finalPath)) {
        return { committed: false, reason: 'storage-failed' }
      }
      this.fs.renameSync(tempPath, finalPath)
      published = true
    } catch {
      return { committed: false, reason: 'storage-failed' }
    } finally {
      if (!published) {
        this.removeQuietly(tempPath)
      }
    }
    const durability: PreparationArchiveDurability = this.syncRoot()
      ? 'established'
      : 'unestablished'
    if (durability === 'unestablished') {
      this.unestablished.add(archiveId)
    }
    return {
      committed: true,
      archiveId,
      finalSequence: header.finalSequence,
      byteLength: header.byteLength,
      committedAt: header.committedAt,
      durability,
      redactionApplied: header.redactionApplied
    }
  }

  /** Newest first; omits revoked generations and unreadable files. */
  list(filter: { host: string; worktreeKey: string }): PreparationOutputArchiveSummary[] {
    return this.readHeaders()
      .filter(
        (header) =>
          header.host === filter.host &&
          header.worktreeKey === filter.worktreeKey &&
          !this.isGenerationRevoked(header.host, header.instanceId)
      )
      .sort((a, b) => b.committedAt - a.committedAt || a.archiveId.localeCompare(b.archiveId))
      .map((header) => ({
        archiveId: header.archiveId,
        preparationId: header.preparationId,
        host: header.host,
        worktreeKey: header.worktreeKey,
        instanceId: header.instanceId,
        incarnationId: header.incarnationId,
        committedAt: header.committedAt,
        byteLength: header.byteLength,
        finalSequence: header.finalSequence,
        durability: this.unestablished.has(header.archiveId) ? 'unestablished' : 'established',
        redactionApplied: header.redactionApplied
      }))
  }

  read(args: { archiveId: string; offset?: number; limit?: number }): PreparationArchivePage {
    const offset = args.offset ?? 0
    const limit = args.limit ?? PREPARATION_OUTPUT_READ_PAGE_MAX_BYTES
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > PREPARATION_OUTPUT_READ_PAGE_MAX_BYTES
    ) {
      throw new PreparationOutputError('preparation_output_read_limit')
    }
    if (!ARCHIVE_ID_PATTERN.test(args.archiveId)) {
      throw new PreparationOutputError('preparation_output_invalid_archive_id')
    }
    const path = this.archivePath(args.archiveId)
    if (!this.fs.existsSync(path)) {
      throw new PreparationOutputError('preparation_output_archive_not_found')
    }
    let fd: number | null = null
    try {
      fd = this.fs.openSync(path, 'r')
      const archive = openArchiveFile(this.fs, fd, args.archiveId)
      if (this.isGenerationRevoked(archive.header.host, archive.header.instanceId)) {
        throw new PreparationOutputError('preparation_output_archive_unavailable')
      }
      return readArchivePage(this.fs, fd, archive, offset, limit)
    } catch (error) {
      if (error instanceof PreparationOutputError) {
        throw error
      }
      throw new PreparationOutputError('preparation_output_archive_unavailable')
    } finally {
      if (fd !== null) {
        this.fs.closeSync(fd)
      }
    }
  }

  /** Deletes the listed archives of one worktree generation; files that could not be removed are reported. */
  purgeArchives(archiveIds: readonly string[]): { removed: string[]; failed: string[] } {
    const removed: string[] = []
    const failed: string[] = []
    for (const archiveId of archiveIds) {
      try {
        this.fs.rmSync(this.archivePath(archiveId), { force: true })
        removed.push(archiveId)
        this.unestablished.delete(archiveId)
      } catch {
        failed.push(archiveId)
      }
    }
    if (removed.length > 0) {
      this.syncRoot()
    }
    return { removed, failed }
  }

  /**
   * Archive ids still on disk keyed by `generationKey`, from one header scan. Unreadable files
   * cannot be attributed; a generation purge must not guess at them.
   */
  archiveIdsByGeneration(): Map<string, string[]> {
    const byGeneration = new Map<string, string[]>()
    for (const header of this.readHeaders()) {
      const key = generationKey(header)
      const ids = byGeneration.get(key)
      if (ids) {
        ids.push(header.archiveId)
      } else {
        byGeneration.set(key, [header.archiveId])
      }
    }
    return byGeneration
  }

  /** Temp files are never published archives; a crash between write and rename leaves them behind. */
  removeStaleTemporaryFiles(): void {
    for (const name of this.listNames()) {
      if (name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX)) {
        this.removeQuietly(join(this.root, name))
      }
    }
  }

  /** Nothing is held open between calls; archives stay on disk. */
  close(): void {
    this.unestablished.clear()
  }

  private readHeaders(): ArchiveHeader[] {
    const headers: ArchiveHeader[] = []
    for (const name of this.listNames()) {
      const archiveId = archiveIdFromName(name)
      const header = archiveId ? this.tryReadHeader(archiveId) : null
      if (header) {
        headers.push(header)
      }
    }
    return headers
  }

  private tryReadHeader(archiveId: string): ArchiveHeader | null {
    let fd: number | null = null
    try {
      fd = this.fs.openSync(this.archivePath(archiveId), 'r')
      return openArchiveFile(this.fs, fd, archiveId).header
    } catch {
      return null
    } finally {
      if (fd !== null) {
        this.fs.closeSync(fd)
      }
    }
  }

  private listNames(): string[] {
    try {
      return this.fs.readdirSync(this.root)
    } catch {
      return []
    }
  }

  private archivePath(archiveId: string): string {
    return join(this.root, `${archiveId}${ARCHIVE_SUFFIX}`)
  }

  private ensurePrivateRoot(): void {
    this.fs.mkdirSync(this.root, { recursive: true, mode: PRIVATE_DIR_MODE })
    if (supportsPosixFileModes()) {
      this.fs.chmodSync(this.root, PRIVATE_DIR_MODE)
    }
  }

  /** Directory fsync makes the rename durable; platforms that refuse it leave durability unproven. */
  private syncRoot(): boolean {
    try {
      fsyncPath(this.fs, this.root, 'r')
      return true
    } catch {
      return false
    }
  }

  private removeQuietly(path: string): void {
    try {
      this.fs.rmSync(path, { force: true })
    } catch {
      // A leftover temp is swept by removeStaleTemporaryFiles; it is never readable as an archive.
    }
  }
}

export function generationKey(generation: { host: string; instanceId: string }): string {
  return JSON.stringify([generation.host, generation.instanceId])
}
