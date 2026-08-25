import { describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
import { RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT } from './client-hosted-browser-page-persistence'
import { adoptRuntimeBrowserClientPagesFromInventory } from './runtime-browser-client-page-adoption'
import { recoverUnavailableRuntimeBrowserClientPages } from './runtime-browser-client-page-recovery'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const freshPlacement = Object.freeze({
  kind: 'client' as const,
  browserHostClientId: 'host-relaunched',
  browserHostGeneration: 1,
  pageHostGeneration: 1
})

describe('recovery of rehydrated client-hosted pages', () => {
  it('recovers a rehydrated row for the paired device that hosted it, under a fresh placement', async () => {
    const { authority, commands, notifyWorkspace, pages } = harness()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease(),
      authority,
      pages,
      notifyWorkspace
    })

    // Nothing to close: the desktop that owned the previous epoch is gone with its runtime.
    expect(commands).toEqual([{ browserPageId: 'page-a', type: 'navigate' }])
    expect(authority.createClientPage).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPageId: 'page-a',
        // The relaunched client's own id and this lease's device, never the persisted record's.
        browserHostClientId: 'host-relaunched',
        pairedDeviceId: 'device-a',
        browserProfileId: 'profile-a',
        executionHostKey: 'native:runtime-a:1'
      })
    )
    expect(pages.getPage('page-a')).toMatchObject({
      placement: freshPlacement,
      url: 'https://restored.internal/',
      loading: false
    })
    expect(notifyWorkspace).toHaveBeenCalledOnce()
  })

  it('leaves a rehydrated row host-absent when another paired device attaches', async () => {
    const { authority, commands, notifyWorkspace, pages } = harness()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: { ...lease(), pairedDeviceId: 'device-b' },
      authority,
      pages,
      notifyWorkspace
    })

    expect(commands).toEqual([])
    expect(authority.createClientPage).not.toHaveBeenCalled()
    // Still listed, still carrying the sentinel: visible to every client and closable by any of them.
    expect(pages.getPage('page-a')?.placement).toEqual(RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT)
    expect(notifyWorkspace).not.toHaveBeenCalled()
  })

  it('never recovers a rehydrated row whose record names no paired device', async () => {
    const { authority, pages } = harness({ pairedDeviceId: undefined })

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease(),
      authority,
      pages,
      notifyWorkspace: vi.fn()
    })

    expect(authority.createClientPage).not.toHaveBeenCalled()
  })

  it('lets adoption take a rehydrated row back when the client still holds the guest', async () => {
    const { pages } = harness()
    const adoptionAuthority = {
      authorityRuntimeId: 'runtime-new',
      authorityEpoch: 'epoch-new',
      getPlacement: vi.fn(() => freshPlacement),
      adoptClientPages: vi.fn(async () => ['page-a'])
    }

    const result = await adoptRuntimeBrowserClientPagesFromInventory({
      lease: adoptionLease(),
      authority: adoptionAuthority,
      pages,
      notifyWorkspace: vi.fn(),
      resolveExecutionHostKey: async () => ({
        status: 'resolved',
        executionHostKey: 'native:runtime-a:1'
      })
    })

    // The persisted record must not shadow a live guest: adoption rekeys the DOM, recovery
    // recreates it, so a row with a guest behind it belongs to adoption.
    expect(result.adoptedPageIds).toEqual(['page-a'])
    expect(pages.getPage('page-a')).toMatchObject({
      placement: freshPlacement,
      url: 'https://client-latest.internal/'
    })
  })
})

function harness(options: { pairedDeviceId?: string } = {}) {
  const pages = new RuntimeBrowserPageRegistry()
  pages.publishClientPage({
    browserPageId: 'page-a',
    workspaceId: 'workspace-a',
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
    ...('pairedDeviceId' in options
      ? options.pairedDeviceId === undefined
        ? {}
        : { pairedDeviceId: options.pairedDeviceId }
      : { pairedDeviceId: 'device-a' }),
    url: 'https://restored.internal/',
    title: 'Restored',
    loading: false,
    active: false
  })
  const commands: { browserPageId: string; type: string }[] = []
  const placements = new Map<string, RuntimeBrowserClientPlacement | undefined>()
  const authority = {
    authorityRuntimeId: 'runtime-new',
    authorityEpoch: 'epoch-new',
    getPlacement: vi.fn((browserPageId: string) => placements.get(browserPageId)),
    beginPageRetirement: vi.fn(
      (browserPageId: string, placement: RuntimeBrowserClientPlacement) => ({
        browserPageId,
        placement
      })
    ),
    completePageRetirement: vi.fn(() => true),
    createClientPage: vi.fn(async (input: { browserPageId: string }) => {
      placements.set(input.browserPageId, freshPlacement)
      return freshPlacement
    }),
    issueClientPageCommand: vi.fn((input: { browserPageId: string }, command: { type: string }) => {
      commands.push({ browserPageId: input.browserPageId, type: command.type })
      return { event: {}, result: Promise.resolve({ status: 'completed' as const }) }
    })
  }
  return { authority, commands, notifyWorkspace: vi.fn(), pages, placements }
}

function lease() {
  return {
    authorityRuntimeId: 'runtime-new',
    authorityEpoch: 'epoch-new',
    browserHostClientId: 'host-relaunched',
    browserHostGeneration: 1,
    pairedDeviceId: 'device-a',
    pageCommandProtocolVersion: 1 as const,
    pageInventoryProtocolVersion: 1 as const,
    pageReconciliationProtocolVersion: 1 as const,
    pageInventory: []
  }
}

function adoptionLease() {
  return {
    ...lease(),
    connectionId: 'conn-a',
    hostCapabilities: [] as readonly string[],
    pageInventory: [
      {
        authorityRuntimeId: 'runtime-old',
        authorityEpoch: 'epoch-old',
        browserHostClientId: 'host-relaunched',
        browserHostGeneration: 1,
        browserPageId: 'page-a',
        pageHostGeneration: 3,
        browserProfileId: 'profile-a',
        executionHostKey: 'native:runtime-a:1',
        workspaceId: 'workspace-a',
        state: 'active' as const,
        currentUrl: 'https://client-latest.internal/'
      }
    ]
  }
}
