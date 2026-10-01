// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreparationOutputDialog } from './preparation-output-dialog'

const WORKTREE_ID = 'repo-1::/repo/wt'
const WORKTREE_RESULT = {
  worktreeId: WORKTREE_ID,
  hostId: 'local',
  instanceId: '11111111-1111-4111-8111-111111111111',
  worktreeKey: 'wt2:local:11111111-1111-4111-8111-111111111111'
}
const OLDER_ID = '44444444-4444-4444-8444-444444444444'
const NEWER_ID = '55555555-5555-4555-8555-555555555555'

type Envelope =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }
type Call = { method: string; params?: Record<string, unknown> }

const runtimeCall = vi.fn<(call: Call) => Promise<Envelope>>()
const ptySpawn = vi.fn()

function summary(archiveId: string, committedAt: number, byteLength: number) {
  return {
    archiveId,
    preparationId: `prep-${archiveId.slice(0, 4)}`,
    host: 'local',
    worktreeKey: WORKTREE_RESULT.worktreeKey,
    instanceId: WORKTREE_RESULT.instanceId,
    incarnationId: `incarnation-${archiveId.slice(0, 4)}`,
    committedAt,
    byteLength,
    finalSequence: byteLength,
    durability: 'established',
    redactionApplied: true
  }
}

function page(archiveId: string, offset: number, text: string, nextOffset: number | null) {
  return {
    archiveId,
    offset,
    text,
    nextOffset,
    byteLength: 64,
    committedAt: 1_711_000_000_000,
    redactionApplied: true
  }
}

function serve(
  archives: Record<string, unknown>[],
  read: (params: Record<string, unknown>) => Envelope
): void {
  runtimeCall.mockImplementation(async ({ method, params = {} }) => {
    if (method === 'preparation.output.list') {
      return { ok: true, result: { worktree: WORKTREE_RESULT, archives } }
    }
    if (method === 'preparation.output.read') {
      return read(params)
    }
    return { ok: false, error: { code: 'method_not_found', message: method } }
  })
}

function renderDialog(): void {
  render(
    <PreparationOutputDialog
      open
      onOpenChange={vi.fn()}
      worktreeId={WORKTREE_ID}
      target={{ kind: 'local' }}
    />
  )
}

beforeEach(() => {
  runtimeCall.mockReset()
  ptySpawn.mockReset()
  Reflect.set(window, 'api', { runtime: { call: runtimeCall }, pty: { spawn: ptySpawn } })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('PreparationOutputDialog', () => {
  it('shows loading, then a no-archive state without reading anything', async () => {
    let releaseList: (value: Envelope) => void = () => {}
    runtimeCall.mockImplementationOnce(
      () =>
        new Promise<Envelope>((resolve) => {
          releaseList = resolve
        })
    )
    renderDialog()

    expect(await screen.findByText(/loading/i)).toBeInTheDocument()
    releaseList({ ok: true, result: { worktree: WORKTREE_RESULT, archives: [] } })

    expect(await screen.findByText(/no preparation output/i)).toBeInTheDocument()
    expect(runtimeCall.mock.calls.map(([call]) => call.method)).toEqual(['preparation.output.list'])
    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'preparation.output.list',
      params: expect.objectContaining({ worktree: `id:${WORKTREE_ID}` })
    })
  })

  it('opens a single archive directly and distinguishes successful empty output', async () => {
    serve([summary(NEWER_ID, 2_000, 0)], () => ({ ok: true, result: page(NEWER_ID, 0, '', null) }))
    renderDialog()

    expect(await screen.findByText(/empty/i)).toBeInTheDocument()
    expect(screen.queryByText(/no preparation output/i)).not.toBeInTheDocument()
    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'preparation.output.read',
      params: expect.objectContaining({ archiveId: NEWER_ID })
    })
  })

  it('shows a read failure as unavailable rather than as empty output', async () => {
    serve([summary(NEWER_ID, 2_000, 10)], () => ({
      ok: false,
      error: {
        code: 'preparation_output_archive_unavailable',
        message: 'preparation_output_archive_unavailable'
      }
    }))
    renderDialog()

    expect(await screen.findByRole('alert')).toHaveTextContent(/unavailable/i)
    expect(screen.queryByText(/empty/i)).not.toBeInTheDocument()
  })

  it('renders HTML and terminal escapes as inert text', async () => {
    const hostile =
      '<img src=x onerror="window.__pwned=1"><a href="https://evil.example">x</a>\u001b[31mred\u001b[0m\n'
    serve([summary(NEWER_ID, 2_000, hostile.length)], () => ({
      ok: true,
      result: page(NEWER_ID, 0, hostile, null)
    }))
    renderDialog()

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog).toHaveTextContent('<img src=x onerror="window.__pwned=1">'))
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog.querySelector('a[href="https://evil.example"]')).toBeNull()
    expect(dialog.textContent).not.toContain('\u001b')
    expect(dialog).toHaveTextContent('red')
  })

  it('offers archives newest first and reads the one the operator selects', async () => {
    serve([summary(NEWER_ID, 2_000, 5), summary(OLDER_ID, 1_000, 5)], (params) => ({
      ok: true,
      result: page(String(params.archiveId), 0, `output of ${String(params.archiveId)}`, null)
    }))
    renderDialog()

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveTextContent('local')
    await userEvent.click(options[1]!)

    expect(await screen.findByText(`output of ${OLDER_ID}`)).toBeInTheDocument()
    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'preparation.output.read',
      params: expect.objectContaining({ archiveId: OLDER_ID })
    })
  })

  it('pages with a keyboard-accessible control and never spawns a terminal', async () => {
    serve([summary(NEWER_ID, 2_000, 20)], (params) =>
      params.offset === 10
        ? { ok: true, result: page(NEWER_ID, 10, 'second-page', null) }
        : { ok: true, result: page(NEWER_ID, 0, 'first-page', 10) }
    )
    renderDialog()

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog).toHaveTextContent('first-page'))
    const more = within(dialog).getByRole('button', { name: /more|next/i })
    more.focus()
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(dialog).toHaveTextContent('second-page'))
    expect(dialog.textContent?.match(/first-page/g) ?? []).toHaveLength(1)
    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'preparation.output.read',
      params: expect.objectContaining({ archiveId: NEWER_ID, offset: 10 })
    })
    const methods = runtimeCall.mock.calls.map(([call]) => call.method)
    expect(methods.every((method) => method.startsWith('preparation.output.'))).toBe(true)
    expect(ptySpawn).not.toHaveBeenCalled()
  })
})
