import React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  toInertPreparationText,
  type PreparationOutputArchiveSummaryWire
} from '../../../../shared/preparation-output-read'
import { usePreparationOutput, type PreparationArchiveReadState } from './use-preparation-output'

function archiveLabel(archive: PreparationOutputArchiveSummaryWire): string {
  const facts = [
    new Date(archive.committedAt).toLocaleString(),
    translate('preparationOutput.archive.host', 'Host {{host}}', { host: archive.host }),
    archive.durability === 'established'
      ? translate('preparationOutput.archive.complete', 'Complete')
      : translate('preparationOutput.archive.durabilityUnproven', 'Saved, durability unproven')
  ]
  if (archive.redactionApplied) {
    facts.push(translate('preparationOutput.archive.redacted', 'Secrets redacted'))
  }
  return facts.join(' · ')
}

function unavailableMessage(code: string): string {
  return translate(
    'preparationOutput.unavailable',
    'Preparation output is unavailable ({{code}}).',
    { code }
  )
}

function ArchiveOutput({
  read,
  onLoadMore
}: {
  read: PreparationArchiveReadState
  onLoadMore: () => void
}): React.JSX.Element | null {
  if (read.status === 'idle') {
    return null
  }
  if (read.status === 'loading') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {translate('preparationOutput.loadingArchive', 'Loading archived output…')}
      </p>
    )
  }
  if (read.status === 'error') {
    return (
      <p role="alert" className="text-sm text-destructive">
        {unavailableMessage(read.code)}
      </p>
    )
  }
  if (read.text.length === 0 && read.nextOffset === null) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {translate(
          'preparationOutput.emptyOutput',
          'Preparation output is empty: the preparation succeeded without printing anything.'
        )}
      </p>
    )
  }
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {/* Why a text node in <pre>: archived output is untrusted and must stay inert. */}
      <pre
        tabIndex={0}
        className="scrollbar-sleek max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap select-text"
      >
        {toInertPreparationText(read.text)}
      </pre>
      {read.nextOffset !== null && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={read.loadingMore}
          onClick={onLoadMore}
        >
          {translate('preparationOutput.loadMore', 'Load more')}
        </Button>
      )}
    </div>
  )
}

export function PreparationOutputDialog({
  open,
  onOpenChange,
  worktreeId,
  target
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktreeId: string
  target: RuntimeClientTarget
}): React.JSX.Element {
  const { list, selectedArchiveId, selectArchive, read, loadMore } = usePreparationOutput({
    open,
    worktreeId,
    target
  })
  const selected =
    list.status === 'ready'
      ? list.archives.find((archive) => archive.archiveId === selectedArchiveId)
      : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{translate('preparationOutput.title', 'Preparation output')}</DialogTitle>
          <DialogDescription>
            {translate(
              'preparationOutput.description',
              'Read-only archive of the setup that prepared this workspace.'
            )}
          </DialogDescription>
        </DialogHeader>
        {list.status === 'loading' && (
          <p role="status" className="text-sm text-muted-foreground">
            {translate('preparationOutput.loadingList', 'Loading preparation output…')}
          </p>
        )}
        {list.status === 'error' && (
          <p role="alert" className="text-sm text-destructive">
            {unavailableMessage(list.code)}
          </p>
        )}
        {list.status === 'ready' && list.archives.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            {translate(
              'preparationOutput.noArchive',
              'No preparation output is archived for this workspace.'
            )}
          </p>
        )}
        {list.status === 'ready' && list.archives.length > 1 && (
          <div
            role="listbox"
            aria-label={translate('preparationOutput.archiveList', 'Preparation runs')}
            className="flex flex-col gap-1"
          >
            {list.archives.map((archive) => (
              <Button
                key={archive.archiveId}
                role="option"
                aria-selected={archive.archiveId === selectedArchiveId}
                variant={archive.archiveId === selectedArchiveId ? 'secondary' : 'ghost'}
                size="sm"
                className="justify-start"
                onClick={() => selectArchive(archive.archiveId)}
              >
                {archiveLabel(archive)}
              </Button>
            ))}
          </div>
        )}
        {selected && list.status === 'ready' && list.archives.length === 1 && (
          <p className="text-xs text-muted-foreground">{archiveLabel(selected)}</p>
        )}
        <ArchiveOutput read={read} onLoadMore={loadMore} />
      </DialogContent>
    </Dialog>
  )
}
