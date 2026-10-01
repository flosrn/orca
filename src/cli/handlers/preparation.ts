import type { CommandHandler } from '../dispatch'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getRequiredWorktreeSelector } from '../selectors'
import {
  toInertPreparationText,
  type PreparationOutputListResult,
  type PreparationOutputPage
} from '../../shared/preparation-output-read'

function formatArchiveList(result: PreparationOutputListResult): string {
  if (result.archives.length === 0) {
    return `No preparation output is archived for ${result.worktree.worktreeId}.`
  }
  return result.archives
    .map((archive) =>
      [
        archive.archiveId,
        new Date(archive.committedAt).toISOString(),
        `host=${archive.host}`,
        `${archive.byteLength} bytes`,
        archive.durability,
        ...(archive.redactionApplied ? ['redacted'] : [])
      ].join('  ')
    )
    .join('\n')
}

// Why: archived bytes are untrusted terminal output; never let them drive the reader's terminal.
function formatPageText(page: PreparationOutputPage): string {
  const text =
    page.text.length === 0 ? '(preparation output was empty)\n' : toInertPreparationText(page.text)
  return page.nextOffset === null ? text : `${text}\n(more output: --offset ${page.nextOffset})`
}

// Why: clients and servers update independently; an Orca server older than preparation archives
// answers method_not_found, which reads as a bug rather than a version gap.
function asIncompatibleRuntime(error: unknown): never {
  if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca server predates preparation archives. Update Orca on the server to read preparation output.'
    )
  }
  throw error
}

export const PREPARATION_HANDLERS: Record<string, CommandHandler> = {
  'preparation output list': async ({ flags, client, cwd, json }) => {
    const result = await client
      .call<PreparationOutputListResult>('preparation.output.list', {
        worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
      })
      .catch(asIncompatibleRuntime)
    printResult(result, json, formatArchiveList)
  },
  'preparation output read': async ({ flags, client, json }) => {
    const archiveId = getRequiredStringFlag(flags, 'archive')
    const offset = getOptionalNonNegativeIntegerFlag(flags, 'offset')
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    const readPage = (pageOffset: number | undefined) =>
      client
        .call<PreparationOutputPage>('preparation.output.read', {
          archiveId,
          ...(pageOffset === undefined ? {} : { offset: pageOffset }),
          ...(limit === undefined ? {} : { limit })
        })
        .catch(asIncompatibleRuntime)
    if (!flags.has('all')) {
      printResult(await readPage(offset), json, formatPageText)
      return
    }
    // Why joined before formatting: an escape sequence may straddle a page boundary.
    const first = await readPage(offset ?? 0)
    const texts = [first.result.text]
    let next = first.result.nextOffset
    while (next !== null) {
      const page = await readPage(next)
      texts.push(page.result.text)
      next = page.result.nextOffset
    }
    const joined = { ...first.result, text: texts.join(''), nextOffset: null }
    printResult({ ...first, result: joined }, json, formatPageText)
  }
}
