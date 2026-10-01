import { PreparationOutputCapture } from './preparation-output-capture'
import type { PreparationOutputChunk } from './preparation-output-contracts'
import type { PreparationRecordStore } from './preparation-record-store'

type EarlyBuffer = { chunks: PreparationOutputChunk[]; bytes: number; overflow: boolean }

export type AttributedCapture = { preparationId: string; capture: PreparationOutputCapture }

/**
 * Routes provider output to preparation captures by exact pty id, never by title or path.
 * Bytes an unbound pty emits while a preparation pane is armed are held until its spawn
 * acknowledgement binds that id; after a restart, a recorded pane's output is held until its
 * live incarnation is confirmed. Every hold is bounded by the capture limit.
 */
export class PreparationOutputAttribution {
  private readonly records: PreparationRecordStore
  private readonly limitBytes: number
  private readonly captures = new Map<string, AttributedCapture>()
  private readonly earlyBuffers = new Map<string, EarlyBuffer>()
  /** Restart: recorded panes whose live incarnation has not been confirmed yet. */
  private readonly awaitingReattach = new Map<
    string,
    { preparationId: string; buffer: EarlyBuffer }
  >()

  constructor(options: { records: PreparationRecordStore; limitBytes: number }) {
    this.records = options.records
    this.limitBytes = options.limitBytes
  }

  observe(ptyId: string, chunk: PreparationOutputChunk): void {
    const active = this.captures.get(ptyId)
    if (active) {
      active.capture.ingest(chunk)
      return
    }
    const awaiting = this.awaitingReattach.get(ptyId)
    if (awaiting) {
      this.appendEarly(awaiting.buffer, chunk)
      return
    }
    // Ordinary terminals have no registration or reservation to attribute.
    if (!this.records.hasPendingReservation()) {
      const bound = this.records.findByPtyId(ptyId)
      if (!bound) {
        this.earlyBuffers.delete(ptyId)
        return
      }
      if (bound.role === 'preparation') {
        this.adopt(ptyId, bound.record.preparationId).capture.ingest(chunk)
      }
      return
    }
    const bound = this.records.findByPtyId(ptyId)
    if (bound) {
      if (bound.role === 'preparation') {
        this.adopt(ptyId, bound.record.preparationId).capture.ingest(chunk)
      }
      return
    }
    if (!this.records.hasPendingReservation()) {
      this.earlyBuffers.delete(ptyId)
      return
    }
    let buffer = this.earlyBuffers.get(ptyId)
    if (!buffer) {
      buffer = emptyBuffer()
      this.earlyBuffers.set(ptyId, buffer)
    }
    this.appendEarly(buffer, chunk)
  }

  capture(ptyId: string): AttributedCapture | undefined {
    return this.captures.get(ptyId)
  }

  /** Starts capturing a freshly bound preparation pane, seeded with any bytes held before the bind. */
  adopt(ptyId: string, preparationId: string): AttributedCapture {
    const existing = this.captures.get(ptyId)
    if (existing) {
      return existing
    }
    const capture = new PreparationOutputCapture({ limitBytes: this.limitBytes })
    const early = this.earlyBuffers.get(ptyId)
    this.earlyBuffers.delete(ptyId)
    replayEarly(capture, early)
    const entry = { preparationId, capture }
    this.captures.set(ptyId, entry)
    return entry
  }

  /** Held bytes belong to no preparation once nothing is armed. */
  dropEarlyIfIdle(): void {
    if (!this.records.hasPendingReservation()) {
      this.earlyBuffers.clear()
    }
  }

  holdForReattach(ptyId: string, preparationId: string): void {
    this.awaitingReattach.set(ptyId, { preparationId, buffer: emptyBuffer() })
  }

  /** True while no live incarnation has settled this recorded pane since restart. */
  awaitsReattach(ptyId: string): boolean {
    return this.awaitingReattach.has(ptyId)
  }

  /** Removes the pending reattachment and returns whom it belonged to, if any. */
  takeReattach(
    ptyId: string
  ): { preparationId: string; resume: (capture: PreparationOutputCapture) => void } | null {
    const awaiting = this.awaitingReattach.get(ptyId)
    if (!awaiting) {
      return null
    }
    this.awaitingReattach.delete(ptyId)
    return {
      preparationId: awaiting.preparationId,
      resume: (capture) => {
        replayEarly(capture, awaiting.buffer)
        this.captures.set(ptyId, { preparationId: awaiting.preparationId, capture })
      }
    }
  }

  /** A reattachment decided without a pending hold still resumes on the recorded pane. */
  resume(ptyId: string, preparationId: string, capture: PreparationOutputCapture): void {
    this.captures.set(ptyId, { preparationId, capture })
  }

  clearReattach(): void {
    this.awaitingReattach.clear()
  }

  forget(ptyId: string): void {
    this.earlyBuffers.delete(ptyId)
    this.captures.delete(ptyId)
    this.awaitingReattach.delete(ptyId)
  }

  private appendEarly(buffer: EarlyBuffer, chunk: PreparationOutputChunk): void {
    if (buffer.overflow) {
      return
    }
    buffer.bytes += Buffer.byteLength(chunk.data)
    if (buffer.bytes > this.limitBytes) {
      buffer.overflow = true
      buffer.chunks = []
      return
    }
    buffer.chunks.push(chunk)
  }
}

function emptyBuffer(): EarlyBuffer {
  return { chunks: [], bytes: 0, overflow: false }
}

function replayEarly(capture: PreparationOutputCapture, early: EarlyBuffer | undefined): void {
  if (!early) {
    return
  }
  if (early.overflow) {
    capture.markIncomplete('overflow')
    return
  }
  for (const chunk of early.chunks) {
    capture.ingest(chunk)
  }
}
