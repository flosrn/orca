import { useCallback, useEffect, useRef, useState } from 'react'
import {
  callRuntimeRpc,
  RuntimeRpcCallError,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import type {
  PreparationOutputArchiveSummaryWire,
  PreparationOutputListResult,
  PreparationOutputPage
} from '../../../../shared/preparation-output-read'

export type PreparationArchiveListState =
  | { status: 'loading' }
  | { status: 'error'; code: string }
  | { status: 'ready'; archives: PreparationOutputArchiveSummaryWire[] }

export type PreparationArchiveReadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; code: string }
  | {
      status: 'ready'
      archiveId: string
      // Raw archived text; callers render it through toInertPreparationText.
      text: string
      nextOffset: number | null
      loadingMore: boolean
    }

function errorCode(error: unknown): string {
  return error instanceof RuntimeRpcCallError ? error.code : 'runtime_error'
}

/** Reads committed preparation archives only; never touches a live terminal or setup. */
export function usePreparationOutput({
  open,
  worktreeId,
  target
}: {
  open: boolean
  worktreeId: string
  target: RuntimeClientTarget
}) {
  const [list, setList] = useState<PreparationArchiveListState>({ status: 'loading' })
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | null>(null)
  const [read, setRead] = useState<PreparationArchiveReadState>({ status: 'idle' })
  // Why: a slow page for a previously selected archive must not overwrite the current one.
  const readGeneration = useRef(0)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setList({ status: 'loading' })
    setSelectedArchiveId(null)
    setRead({ status: 'idle' })
    callRuntimeRpc<PreparationOutputListResult>(target, 'preparation.output.list', {
      worktree: `id:${worktreeId}`
    })
      .then((result) => {
        if (cancelled) {
          return
        }
        setList({ status: 'ready', archives: result.archives })
        const [only] = result.archives
        if (result.archives.length === 1 && only) {
          setSelectedArchiveId(only.archiveId)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setList({ status: 'error', code: errorCode(error) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, worktreeId, target])

  useEffect(() => {
    if (!selectedArchiveId) {
      return
    }
    const generation = ++readGeneration.current
    setRead({ status: 'loading' })
    callRuntimeRpc<PreparationOutputPage>(target, 'preparation.output.read', {
      archiveId: selectedArchiveId,
      offset: 0
    })
      .then((page) => {
        if (generation === readGeneration.current) {
          setRead({
            status: 'ready',
            archiveId: selectedArchiveId,
            text: page.text,
            nextOffset: page.nextOffset,
            loadingMore: false
          })
        }
      })
      .catch((error: unknown) => {
        if (generation === readGeneration.current) {
          setRead({ status: 'error', code: errorCode(error) })
        }
      })
  }, [selectedArchiveId, target])

  const loadMore = useCallback(() => {
    if (read.status !== 'ready' || read.nextOffset === null || read.loadingMore) {
      return
    }
    const generation = readGeneration.current
    const { archiveId, nextOffset } = read
    setRead({ ...read, loadingMore: true })
    callRuntimeRpc<PreparationOutputPage>(target, 'preparation.output.read', {
      archiveId,
      offset: nextOffset
    })
      .then((page) => {
        if (generation !== readGeneration.current) {
          return
        }
        setRead((current) =>
          current.status === 'ready' && current.archiveId === archiveId
            ? {
                ...current,
                text: current.text + page.text,
                nextOffset: page.nextOffset,
                loadingMore: false
              }
            : current
        )
      })
      .catch((error: unknown) => {
        if (generation === readGeneration.current) {
          setRead({ status: 'error', code: errorCode(error) })
        }
      })
  }, [read, target])

  return { list, selectedArchiveId, selectArchive: setSelectedArchiveId, read, loadMore }
}
