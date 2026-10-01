import {
  PREPARATION_OUTPUT_CAPTURE_LIMIT_BYTES,
  type PreparationOutputChunk,
  type PreparationOutputIncompleteness,
  type PreparationOutputSnapshot
} from './preparation-output-contracts'

/**
 * Provider-ordered capture of one preparation pane, from provider sequence 0.
 * Coverage is tracked against the runtime's cumulative provider offsets so replayed frames are
 * dropped exactly and any hole is observed rather than papered over. Incompleteness is sticky.
 */
export class PreparationOutputCapture {
  private readonly limitBytes: number
  private chunks: string[] = []
  private coveredSequence = 0
  private byteLength = 0
  private incomplete: PreparationOutputIncompleteness | null = null

  constructor(options?: { limitBytes?: number }) {
    this.limitBytes = options?.limitBytes ?? PREPARATION_OUTPUT_CAPTURE_LIMIT_BYTES
    if (!Number.isSafeInteger(this.limitBytes) || this.limitBytes <= 0) {
      throw new Error(
        `PreparationOutputCapture limit must be a positive integer, got ${this.limitBytes}`
      )
    }
  }

  /**
   * Resumes the same live incarnation after restart from its committed archive, which already
   * covers `finalSequence` from 0. The seed is redacted text; redaction is idempotent.
   */
  static resume(
    archive: { text: string; finalSequence: number },
    options?: { limitBytes?: number }
  ): PreparationOutputCapture {
    const capture = new PreparationOutputCapture(options)
    if (!Number.isSafeInteger(archive.finalSequence) || archive.finalSequence < 0) {
      capture.markIncomplete('missing-beginning')
      return capture
    }
    capture.chunks = [archive.text]
    capture.coveredSequence = archive.finalSequence
    capture.byteLength = Buffer.byteLength(archive.text)
    capture.enforceLimit()
    return capture
  }

  ingest(chunk: PreparationOutputChunk): void {
    if (this.incomplete) {
      return
    }
    const { startSequence, endSequence, data } = chunk
    if (
      !Number.isSafeInteger(startSequence) ||
      !Number.isSafeInteger(endSequence) ||
      startSequence < 0 ||
      endSequence < startSequence
    ) {
      this.markIncomplete('sequence-gap')
      return
    }
    if (endSequence <= this.coveredSequence) {
      // Replay of output already captured; zero-length frames at the edge carry nothing new.
      return
    }
    if (startSequence > this.coveredSequence) {
      this.markIncomplete(this.coveredSequence === 0 ? 'missing-beginning' : 'sequence-gap')
      return
    }
    let piece = data
    if (startSequence < this.coveredSequence) {
      // A partial replay can be trimmed exactly only when the text maps 1:1 onto provider chars.
      if (data.length !== endSequence - startSequence) {
        this.markIncomplete('sequence-gap')
        return
      }
      piece = data.slice(this.coveredSequence - startSequence)
    }
    this.chunks.push(piece)
    this.byteLength += Buffer.byteLength(piece)
    this.coveredSequence = endSequence
    this.enforceLimit()
  }

  /** For runtime-observed losses that carry no chunk, such as dropped output or a late attach. */
  markIncomplete(reason: PreparationOutputIncompleteness): void {
    if (this.incomplete) {
      return
    }
    this.incomplete = reason
    this.chunks = []
  }

  snapshot(): PreparationOutputSnapshot {
    if (this.incomplete) {
      return {
        authoritative: false,
        reason: this.incomplete,
        finalSequence: this.incomplete === 'missing-beginning' ? null : this.coveredSequence
      }
    }
    const text = this.chunks.join('')
    this.chunks = text.length > 0 ? [text] : []
    return {
      authoritative: true,
      text,
      finalSequence: this.coveredSequence,
      byteLength: Buffer.byteLength(text)
    }
  }

  private enforceLimit(): void {
    if (this.byteLength > this.limitBytes) {
      this.markIncomplete('overflow')
    }
  }
}
