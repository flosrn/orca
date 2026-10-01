import { mkdtempSync, rmSync, statSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { supportsPosixFileModes } from '../../daemon/daemon-private-file-modes'
import { redactString } from '../../observability/redactor'
import { redactWorkerTerminalLines } from '../orchestration/worker-transcript-payload'
import { RECENT_PTY_OUTPUT_LIMIT } from '../recent-pty-output-buffer'
import { DEFAULT_TERMINAL_READ_LIMIT } from '../terminal-tail-limits'
import {
  PREPARATION_OUTPUT_CAPTURE_LIMIT_BYTES,
  PREPARATION_OUTPUT_READ_PAGE_MAX_BYTES,
  type PreparationOutputChunk,
  type PreparationOutputFilesystem
} from './preparation-output-contracts'
import { PreparationOutputCapture } from './preparation-output-capture'
import { renderArchive } from './preparation-output-archive-file'
import { PreparationOutputStore } from './preparation-output-store'

const COMMITTED_AT = 1_711_000_000_000
const BEGIN = 'preparation-begin-marker'
const PARTIAL = 'partial-final-line'
const PEM_BODY = 'MII-not-a-real-key-body-9f3a'
const LABELED_VALUE = 'launch-token-value-9f3a'
const DISPATCH_TOKEN = `dcap_${'Abcdefghij0123456789abcd'}`

const HEADER_KEYS = [
  'archiveId',
  'byteLength',
  'committedAt',
  'finalSequence',
  'host',
  'incarnationId',
  'instanceId',
  'preparationId',
  'redactionApplied',
  'version',
  'worktreeKey'
]

const IDENTITY = {
  preparationId: 'prep-1',
  host: 'localhost',
  worktreeKey: 'wt2:localhost:instance-1',
  instanceId: 'instance-1',
  incarnationId: 'incarnation-1'
}

it('keeps the beginning, the final partial line, and joined secrets in a private archive', () => {
  const chunks = providerChunks(rawPieces())
  const raw = chunks.map((chunk) => chunk.data).join('')
  const expectedArchive = redactWorkerTerminalLines([redactString(raw)]).lines[0]!
  expect(raw.slice(-RECENT_PTY_OUTPUT_LIMIT).includes(BEGIN)).toBe(false)
  expect(raw.split('\n').slice(-DEFAULT_TERMINAL_READ_LIMIT).join('\n').includes(BEGIN)).toBe(false)

  const capture = new PreparationOutputCapture()
  const last = chunks.at(-1)!
  for (const chunk of chunks.slice(0, -1)) {
    capture.ingest(chunk)
  }
  // Replayed provider frames, whole or overlapping the covered edge, are captured exactly once.
  capture.ingest(chunks[0]!)
  capture.ingest({
    startSequence: last.startSequence - 3,
    endSequence: last.endSequence,
    data: `ne\n${PARTIAL}`
  })
  capture.ingest(last)
  const snapshot = capture.snapshot()
  expect(snapshot).toEqual({
    authoritative: true,
    text: raw,
    finalSequence: raw.length,
    byteLength: Buffer.byteLength(raw)
  })

  const root = join(mkdtempSync(join(tmpdir(), 'orca-preparation-output-')), 'archives')
  const syscalls: string[] = []
  const store = new PreparationOutputStore({
    root,
    filesystem: recordingFilesystem(syscalls),
    now: () => COMMITTED_AT
  })
  try {
    const committed = store.commit({ identity: IDENTITY, snapshot })
    expect(committed).toMatchObject({
      committed: true,
      finalSequence: raw.length,
      byteLength: Buffer.byteLength(expectedArchive),
      committedAt: COMMITTED_AT,
      durability: directoryFsyncSupported() ? 'established' : 'unestablished',
      redactionApplied: true
    })
    if (!committed.committed) {
      return
    }
    const renameAt = syscalls.indexOf('rename')
    expect(renameAt).toBeGreaterThan(-1)
    expect(syscalls.slice(0, renameAt)).toContain('fsync:file')
    if (directoryFsyncSupported()) {
      expect(syscalls.slice(renameAt + 1)).toContain('fsync:directory')
    }
    const archivePath = join(root, `${committed.archiveId}.json`)
    if (supportsPosixFileModes()) {
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(statSync(archivePath).mode & 0o777).toBe(0o600)
    }
    expect(nodeFs.readdirSync(root)).toEqual([`${committed.archiveId}.json`])

    store.close()
    const reopened = new PreparationOutputStore({ root })
    const archived = readAll(reopened, committed.archiveId)
    expect(archived).toBe(expectedArchive)
    expect(archived.startsWith(`${BEGIN}\n`)).toBe(true)
    expect(archived.endsWith(PARTIAL)).toBe(true)
    for (const secret of [PEM_BODY, LABELED_VALUE, DISPATCH_TOKEN]) {
      expect(archived.includes(secret)).toBe(false)
    }
    expect(archived).toContain('[redacted:pem]')
    expect(archived).toContain('[redacted:labeled-kv]')
    expect(archived).toContain('[dispatch capability redacted]')
    expect(reopened.list({ host: IDENTITY.host, worktreeKey: IDENTITY.worktreeKey })).toEqual([
      expect.objectContaining({ archiveId: committed.archiveId, durability: 'established' })
    ])

    const file = nodeFs.readFileSync(archivePath, 'utf8')
    const header = JSON.parse(file.slice(0, file.indexOf('\n')))
    expect(Object.keys(header).sort()).toEqual(HEADER_KEYS)
    for (const secret of [PEM_BODY, LABELED_VALUE, DISPATCH_TOKEN]) {
      expect(file.includes(secret)).toBe(false)
    }

    // Later output is a new snapshot and archive; the committed one never changes.
    capture.ingest({ startSequence: raw.length, endSequence: raw.length + 6, data: '\nlater' })
    const again = reopened.commit({ identity: IDENTITY, snapshot: capture.snapshot() })
    expect(again).toMatchObject({ committed: true, finalSequence: raw.length + 6 })
    if (again.committed) {
      expect(again.archiveId).not.toBe(committed.archiveId)
    }
    expect(nodeFs.readFileSync(archivePath, 'utf8')).toBe(file)
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true })
  }
})

it('refuses an authoritative archive when provider offsets leave a gap or miss the beginning', () => {
  const gapped = new PreparationOutputCapture()
  gapped.ingest({ startSequence: 0, endSequence: 6, data: 'first\n' })
  gapped.ingest({ startSequence: 9, endSequence: 15, data: 'third\n' })
  gapped.ingest({ startSequence: 6, endSequence: 9, data: 'mid' })
  expect(gapped.snapshot()).toEqual({
    authoritative: false,
    reason: 'sequence-gap',
    finalSequence: 6
  })

  const late = new PreparationOutputCapture()
  late.ingest({ startSequence: 40, endSequence: 45, data: 'late\n' })
  expect(late.snapshot()).toMatchObject({ authoritative: false, reason: 'missing-beginning' })

  // A transformed chunk cannot be trimmed exactly, so a partial replay of it is a gap.
  const transformed = new PreparationOutputCapture()
  transformed.ingest({ startSequence: 0, endSequence: 10, data: 'ten chars!' })
  transformed.ingest({ startSequence: 5, endSequence: 20, data: 'rewritten' })
  expect(transformed.snapshot()).toMatchObject({ authoritative: false, reason: 'sequence-gap' })

  const root = mkdtempSync(join(tmpdir(), 'orca-preparation-gap-'))
  const store = new PreparationOutputStore({ root, now: () => COMMITTED_AT })
  try {
    expect(store.commit({ identity: IDENTITY, snapshot: gapped.snapshot() })).toEqual({
      committed: false,
      reason: 'sequence-gap'
    })
    expect(store.commit({ identity: IDENTITY, snapshot: late.snapshot() })).toEqual({
      committed: false,
      reason: 'missing-beginning'
    })
    expect(nodeFs.readdirSync(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('refuses an authoritative archive when the joined capture exceeds 16 MiB of UTF-8', () => {
  // UTF-8 overflows by one byte while UTF-16 code units stay two under the limit.
  const data = `${'x'.repeat(PREPARATION_OUTPUT_CAPTURE_LIMIT_BYTES - 3)}😀`
  expect(Buffer.byteLength(data)).toBe(PREPARATION_OUTPUT_CAPTURE_LIMIT_BYTES + 1)
  const capture = new PreparationOutputCapture()
  capture.ingest({ startSequence: 0, endSequence: data.length, data })
  expect(capture.snapshot()).toMatchObject({ authoritative: false, reason: 'overflow' })
  capture.ingest({ startSequence: data.length, endSequence: data.length + 6, data: 'later\n' })
  expect(capture.snapshot()).toMatchObject({ authoritative: false, reason: 'overflow' })

  const root = mkdtempSync(join(tmpdir(), 'orca-preparation-overflow-'))
  const store = new PreparationOutputStore({ root, now: () => COMMITTED_AT })
  try {
    expect(store.commit({ identity: IDENTITY, snapshot: capture.snapshot() })).toEqual({
      committed: false,
      reason: 'overflow'
    })
    expect(nodeFs.readdirSync(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('pages on UTF-8 boundaries and names unreadable archives', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-preparation-paging-'))
  const store = new PreparationOutputStore({ root, now: () => COMMITTED_AT })
  try {
    const text = `ab😀cd${'é'.repeat(10)}`
    const committed = store.commit({
      identity: IDENTITY,
      snapshot: {
        authoritative: true,
        text,
        finalSequence: text.length,
        byteLength: Buffer.byteLength(text)
      }
    })
    if (!committed.committed) {
      throw new Error('commit refused')
    }
    const first = store.read({ archiveId: committed.archiveId, offset: 0, limit: 4 })
    expect(first).toMatchObject({ text: 'ab', nextOffset: 2 })
    expect(store.read({ archiveId: committed.archiveId, offset: 2, limit: 2 })).toMatchObject({
      text: '😀',
      nextOffset: 6
    })
    expect(readAll(store, committed.archiveId, 3)).toBe(text)
    expect(() => store.read({ archiveId: committed.archiveId, offset: 3 })).toThrow(
      'preparation_output_read_offset'
    )
    expect(() => store.read({ archiveId: '../escape' })).toThrow(
      'preparation_output_invalid_archive_id'
    )
    expect(() => store.read({ archiveId: '00000000-0000-4000-8000-000000000000' })).toThrow(
      'preparation_output_archive_not_found'
    )
    // A torn file is never served as a complete archive.
    const path = join(root, `${committed.archiveId}.json`)
    nodeFs.chmodSync(path, 0o600)
    nodeFs.appendFileSync(path, 'torn')
    expect(() => store.read({ archiveId: committed.archiveId })).toThrow(
      'preparation_output_archive_unavailable'
    )

    const revoked = new PreparationOutputStore({ root, isGenerationRevoked: () => true })
    expect(revoked.list({ host: IDENTITY.host, worktreeKey: IDENTITY.worktreeKey })).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('normalizes terminal escapes before redacting so setup-script secrets never reach the archive', () => {
  const secrets = {
    traced: 'trace-value-7c1e9a',
    coloured: 'colour-value-7c1e9a',
    split: 'split-value-7c1e9a',
    declared: 'declared-value-7c1e9a',
    inline: 'inline-pass-7c1e9a',
    userinfo: 'userinfo-pass-7c1e9a'
  }
  const raw = [
    '\u001b]0;setup\u0007$ ./setup.sh\r\n',
    `+ export GITHUB_TOKEN=${secrets.traced}\r\n`,
    `\u001b[0mSTRIPE_SECRET_KEY=${secrets.coloured}\u001b[0m\r\n`,
    `API_\u001b[1mTOKEN=${secrets.split}\n`,
    `declare -x NPM_AUTH="${secrets.declared}"\n`,
    `++ mysql -e init MYSQL_ROOT_PASSWORD=${secrets.inline} --quiet\n`,
    `DATABASE_URL: postgres://admin:${secrets.userinfo}@db.internal:5432/app\n`,
    'progress 10%\rprogress 100%\n$ '
  ].join('')
  const { header, payload } = renderArchive({
    archiveId: '00000000-0000-4000-8000-000000000001',
    identity: IDENTITY,
    text: raw,
    finalSequence: raw.length,
    committedAt: COMMITTED_AT
  })
  const body = payload.toString('utf8').slice(payload.indexOf('\n') + 1)
  for (const secret of Object.values(secrets)) {
    expect(body.includes(secret)).toBe(false)
  }
  for (const control of ['\u001b', '\r', '\u0007']) {
    expect(body.includes(control)).toBe(false)
  }
  expect(body).toContain('$ ./setup.sh\n')
  expect(body).toContain('+ export GITHUB_TOKEN=[redacted:env-value]\n')
  expect(body).toContain('STRIPE_SECRET_KEY=[redacted:env-value]\n')
  expect(body).toContain('postgres://[redacted]@db.internal:5432/app')
  expect(body.endsWith('progress 10%\nprogress 100%\n$ ')).toBe(true)
  expect(header).toMatchObject({ redactionApplied: true, byteLength: Buffer.byteLength(body) })
})

it('does not label an archive redacted when only terminal escapes were removed', () => {
  const raw = '\u001b[32mok\u001b[0m\r\n$ '
  const { header, payload } = renderArchive({
    archiveId: '00000000-0000-4000-8000-000000000002',
    identity: IDENTITY,
    text: raw,
    finalSequence: raw.length,
    committedAt: COMMITTED_AT
  })
  expect(payload.toString('utf8').slice(payload.indexOf('\n') + 1)).toBe('ok\n$ ')
  expect(header.redactionApplied).toBe(false)
})

function rawPieces(): string[] {
  const filler = Array.from({ length: DEFAULT_TERMINAL_READ_LIMIT + 10 }, (_, index) => {
    return `line-${String(index).padStart(4, '0')}-${'x'.repeat(600)}`
  }).join('\n')
  // Assembled from parts so no literal key block lives in the repository.
  const pemLabel = ['PRIVATE', 'KEY'].join(' ')
  const pem = `-----BEGIN ${pemLabel}-----\n${PEM_BODY}\n-----END ${pemLabel}-----`
  return [
    `${BEGIN}\n`,
    `${filler}\n`,
    'tok',
    `en: ${LABELED_VALUE}\n`,
    pem.slice(0, 20),
    pem.slice(20, 40),
    `${pem.slice(40)}\n`,
    DISPATCH_TOKEN.slice(0, 8),
    `${DISPATCH_TOKEN.slice(8)}\nline\n`,
    PARTIAL
  ]
}

/** Mirrors the runtime: each chunk ends at the cumulative provider offset. */
function providerChunks(pieces: readonly string[]): PreparationOutputChunk[] {
  let sequence = 0
  return pieces.map((data) => {
    const chunk = { startSequence: sequence, endSequence: sequence + data.length, data }
    sequence = chunk.endSequence
    return chunk
  })
}

function readAll(store: PreparationOutputStore, archiveId: string, limit = 1024): string {
  const pages: string[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const page = store.read({ archiveId, offset, limit })
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(Math.max(limit, 4))
    expect(page.committedAt).toBe(COMMITTED_AT)
    pages.push(page.text)
    offset = page.nextOffset
  }
  expect(() =>
    store.read({ archiveId, offset: 0, limit: PREPARATION_OUTPUT_READ_PAGE_MAX_BYTES + 1 })
  ).toThrow('preparation_output_read_limit')
  return pages.join('')
}

function recordingFilesystem(syscalls: string[]): PreparationOutputFilesystem {
  return {
    ...pickFilesystem(),
    fsyncSync: (fd: number) => {
      syscalls.push(nodeFs.fstatSync(fd).isDirectory() ? 'fsync:directory' : 'fsync:file')
      nodeFs.fsyncSync(fd)
    },
    renameSync: (from: nodeFs.PathLike, to: nodeFs.PathLike) => {
      syscalls.push('rename')
      nodeFs.renameSync(from, to)
    }
  }
}

function pickFilesystem(): PreparationOutputFilesystem {
  const {
    mkdirSync,
    writeFileSync,
    openSync,
    readSync,
    fsyncSync,
    fstatSync,
    closeSync,
    renameSync,
    readFileSync,
    readdirSync,
    statSync: stat,
    chmodSync,
    rmSync: rm,
    existsSync
  } = nodeFs
  return {
    mkdirSync,
    writeFileSync,
    openSync,
    readSync,
    fsyncSync,
    fstatSync,
    closeSync,
    renameSync,
    readFileSync,
    readdirSync,
    statSync: stat,
    chmodSync,
    rmSync: rm,
    existsSync
  }
}

function directoryFsyncSupported(): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'orca-preparation-dir-fsync-'))
  let fd: number | null = null
  try {
    fd = nodeFs.openSync(directory, 'r')
    nodeFs.fsyncSync(fd)
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) {
      nodeFs.closeSync(fd)
    }
    rmSync(directory, { recursive: true, force: true })
  }
}
