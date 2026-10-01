import { redactString } from '../../observability/redactor'
import { toInertPreparationText } from '../../../shared/preparation-output-read'
import { redactWorkerTerminalLines } from '../orchestration/worker-transcript-payload'
import {
  PREPARATION_OUTPUT_ARCHIVE_VERSION,
  PreparationOutputError,
  type PreparationArchiveIdentity,
  type PreparationArchivePage,
  type PreparationOutputFilesystem
} from './preparation-output-contracts'

export const ARCHIVE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const ARCHIVE_SUFFIX = '.json'
export const TEMP_PREFIX = '.'
export const TEMP_SUFFIX = '.tmp'
const MAX_HEADER_BYTES = 64 * 1024

// Setup-script shapes the general redactor misses: `set -x` traces (`+ export NAME=`, `+ NAME=`),
// `declare -x`/`readonly` listings, secret-named variables mid-line, and non-HTTP URL credentials.
const SHELL_KEYWORD_ASSIGNMENT =
  /^([ \t]*(?:\++[ \t]*)?(?:export|readonly|local|typeset|declare)(?:[ \t]+-[A-Za-z]+)*[ \t]+)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*\S[^\n]*/gm
const TRACED_ASSIGNMENT = /^([ \t]*\++[ \t]*)([A-Z_][A-Z0-9_]*)=\S[^\n]*/gm
const SECRET_NAMED_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:_TOKEN|_SECRET|_KEY|PASSWORD|PASSWD)[A-Za-z0-9_]*)[ \t]*[=:][ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi
const ANY_SCHEME_USERINFO = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s]+)@/g

/** Archive file: this JSON header line, then the normalized, redacted UTF-8 body. */
export type ArchiveHeader = {
  version: typeof PREPARATION_OUTPUT_ARCHIVE_VERSION
  archiveId: string
  preparationId: string
  host: string
  worktreeKey: string
  instanceId: string
  incarnationId: string
  finalSequence: number
  byteLength: number
  committedAt: number
  redactionApplied: boolean
}

export type OpenArchive = { header: ArchiveHeader; bodyOffset: number }

/**
 * Normalizes the joined capture to inert text (escapes and control bytes removed, CR/CRLF as LF)
 * and only then redacts it, so an escape sequence or carriage return can neither split a secret
 * from its label nor hide a line start from a line-anchored rule. Both passes run on the whole
 * text so chunk boundaries cannot split a secret. The archive is therefore normalized text, not
 * the raw PTY stream.
 */
export function renderArchive(args: {
  archiveId: string
  identity: PreparationArchiveIdentity
  text: string
  finalSequence: number
  committedAt: number
}): { header: ArchiveHeader; payload: Buffer } {
  const { identity } = args
  assertIdentity(identity)
  const normalized = toInertPreparationText(args.text)
  const text = redactPreparationText(normalized)
  const body = Buffer.from(text, 'utf8')
  const header: ArchiveHeader = {
    version: PREPARATION_OUTPUT_ARCHIVE_VERSION,
    archiveId: args.archiveId,
    preparationId: identity.preparationId,
    host: identity.host,
    worktreeKey: identity.worktreeKey,
    instanceId: identity.instanceId,
    incarnationId: identity.incarnationId,
    finalSequence: args.finalSequence,
    byteLength: body.length,
    committedAt: args.committedAt,
    redactionApplied: text !== normalized
  }
  return {
    header,
    payload: Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), body])
  }
}

/** Idempotent, so a resumed capture seeded from an archive can be redacted again. */
function redactPreparationText(normalized: string): string {
  const shellRedacted = normalized
    .replace(SHELL_KEYWORD_ASSIGNMENT, '$1$2=[redacted:env-value]')
    .replace(TRACED_ASSIGNMENT, '$1$2=[redacted:env-value]')
    .replace(SECRET_NAMED_ASSIGNMENT, '$1=[redacted:env-value]')
    .replace(ANY_SCHEME_USERINFO, '$1[redacted]@')
  return redactWorkerTerminalLines([redactString(shellRedacted)]).lines[0] ?? ''
}

/** Reads and validates the header line; a torn or foreign file is never a complete archive. */
export function openArchiveFile(
  fs: PreparationOutputFilesystem,
  fd: number,
  archiveId: string
): OpenArchive {
  const probe = Buffer.alloc(MAX_HEADER_BYTES)
  const read = fs.readSync(fd, probe, 0, MAX_HEADER_BYTES, 0)
  const newline = probe.subarray(0, read).indexOf(0x0a)
  if (newline === -1) {
    throw new PreparationOutputError('preparation_output_archive_unavailable')
  }
  const header = parseHeader(probe.subarray(0, newline).toString('utf8'))
  const bodyOffset = newline + 1
  if (
    !header ||
    header.archiveId !== archiveId ||
    fs.fstatSync(fd).size !== bodyOffset + header.byteLength
  ) {
    throw new PreparationOutputError('preparation_output_archive_unavailable')
  }
  return { header, bodyOffset }
}

/** One page of body text on UTF-8 boundaries; offsets are body byte offsets. */
export function readArchivePage(
  fs: PreparationOutputFilesystem,
  fd: number,
  archive: OpenArchive,
  offset: number,
  limit: number
): PreparationArchivePage {
  const { header, bodyOffset } = archive
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > header.byteLength) {
    throw new PreparationOutputError('preparation_output_read_offset')
  }
  // A code point is at most 4 bytes; read that much past the page to find its boundary.
  const span = Math.min(limit + 4, header.byteLength - offset)
  const buffer = Buffer.alloc(span)
  const read = span > 0 ? fs.readSync(fd, buffer, 0, span, bodyOffset + offset) : 0
  if (read !== span) {
    throw new PreparationOutputError('preparation_output_archive_unavailable')
  }
  if (span > 0 && isContinuationByte(buffer[0]!)) {
    throw new PreparationOutputError('preparation_output_read_offset')
  }
  const end = pageEnd(buffer, Math.min(limit, span))
  return {
    archiveId: header.archiveId,
    offset,
    text: buffer.subarray(0, end).toString('utf8'),
    nextOffset: offset + end >= header.byteLength ? null : offset + end,
    byteLength: header.byteLength,
    committedAt: header.committedAt,
    redactionApplied: header.redactionApplied
  }
}

export function fsyncPath(fs: PreparationOutputFilesystem, path: string, flags: 'r' | 'r+'): void {
  const fd = fs.openSync(path, flags)
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function assertIdentity(identity: PreparationArchiveIdentity): void {
  for (const value of [
    identity.preparationId,
    identity.host,
    identity.worktreeKey,
    identity.instanceId,
    identity.incarnationId
  ]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('Preparation archive identity requires non-empty ids')
    }
  }
}

export function archiveIdFromName(name: string): string | null {
  if (!name.endsWith(ARCHIVE_SUFFIX)) {
    return null
  }
  const archiveId = name.slice(0, -ARCHIVE_SUFFIX.length)
  return ARCHIVE_ID_PATTERN.test(archiveId) ? archiveId : null
}

function parseHeader(line: string): ArchiveHeader | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate: Partial<Record<keyof ArchiveHeader, unknown>> = value
  const strings = [
    candidate.archiveId,
    candidate.preparationId,
    candidate.host,
    candidate.worktreeKey,
    candidate.instanceId,
    candidate.incarnationId
  ]
  if (
    candidate.version !== PREPARATION_OUTPUT_ARCHIVE_VERSION ||
    !strings.every((field) => typeof field === 'string') ||
    !isNonNegativeInteger(candidate.finalSequence) ||
    !isNonNegativeInteger(candidate.byteLength) ||
    !isNonNegativeInteger(candidate.committedAt) ||
    typeof candidate.redactionApplied !== 'boolean'
  ) {
    return null
  }
  return {
    version: PREPARATION_OUTPUT_ARCHIVE_VERSION,
    archiveId: String(candidate.archiveId),
    preparationId: String(candidate.preparationId),
    host: String(candidate.host),
    worktreeKey: String(candidate.worktreeKey),
    instanceId: String(candidate.instanceId),
    incarnationId: String(candidate.incarnationId),
    finalSequence: Number(candidate.finalSequence),
    byteLength: Number(candidate.byteLength),
    committedAt: Number(candidate.committedAt),
    redactionApplied: candidate.redactionApplied
  }
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

/** Largest end ≤ limit on a code-point boundary; a single code point wider than limit is kept whole. */
function pageEnd(buffer: Buffer, limit: number): number {
  if (buffer.length === 0) {
    return 0
  }
  let end = limit
  while (end > 0 && end < buffer.length && isContinuationByte(buffer[end]!)) {
    end -= 1
  }
  if (end > 0) {
    return end
  }
  end = 1
  while (end < buffer.length && isContinuationByte(buffer[end]!)) {
    end += 1
  }
  return end
}
