import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const ACTIVE_EMAIL = 'active-account@example.com'
const SECOND_EMAIL = 'second-account@example.com'
const THIRD_EMAIL = 'third-account@example.com'

/**
 * Proves the rendered status bar carries one meter per Claude account rather than only the
 * active one. State is injected through the renderer store: provisioning two real OAuth
 * logins is not needed to exercise the lane build and its DOM.
 */
test('renders one status-bar meter per provider account', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)

  await orcaPage.evaluate(
    async ({ activeEmail, secondEmail }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      await store.getState().ensureDetectedAgents()
      const previous = store.getState()
      if (!previous.settings) {
        throw new Error('settings are not hydrated yet')
      }
      const window5h = {
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      }
      store.setState({
        // Finish discovery before injecting the fixture; CI has no Claude CLI.
        detectedAgentIds: ['claude'],
        statusBarItems: ['claude'],
        settings: {
          ...previous.settings,
          activeRuntimeEnvironmentId: null,
          activeClaudeManagedAccountId: 'account-active',
          activeClaudeManagedAccountIdsByRuntime: { host: 'account-active', wsl: {} },
          claudeManagedAccounts: [
            {
              id: 'account-active',
              email: activeEmail,
              managedAuthPath: '/tmp/account-active/auth',
              authMethod: 'subscription-oauth',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            },
            {
              id: 'account-second',
              email: secondEmail,
              managedAuthPath: '/tmp/account-second/auth',
              authMethod: 'subscription-oauth',
              createdAt: 2,
              updatedAt: 2,
              lastAuthenticatedAt: 2
            }
          ]
        },
        rateLimits: {
          ...previous.rateLimits,
          claude: {
            provider: 'claude',
            session: { ...window5h, usedPercent: 41 },
            weekly: null,
            updatedAt: Date.now(),
            error: null,
            status: 'ok'
          },
          activeClaudeAccountId: 'account-active',
          activeCodexAccountId: null,
          claudeSystemDefault: null,
          codexSystemDefault: null,
          inactiveClaudeAccounts: [
            {
              accountId: 'account-second',
              updatedAt: Date.now(),
              isFetching: false,
              rateLimits: {
                provider: 'claude',
                session: { ...window5h, usedPercent: 87 },
                weekly: null,
                updatedAt: Date.now(),
                error: null,
                status: 'ok'
              }
            }
          ]
        }
      })
    },
    { activeEmail: ACTIVE_EMAIL, secondEmail: SECOND_EMAIL }
  )

  // Each account is its own meter, discoverable by the email disclosed on hover.
  const activeMeter = orcaPage.locator(`[title="${ACTIVE_EMAIL}"]`)
  const secondMeter = orcaPage.locator(`[title="${SECOND_EMAIL}"]`)
  await expect(activeMeter).toBeVisible()
  await expect(secondMeter).toBeVisible()

  // Ordinals label the lanes in a stable order.
  await expect(activeMeter).toHaveText(/1$/)
  await expect(secondMeter).toHaveText(/2$/)

  // Both accounts' own percentages are on the bar, not the active one twice.
  // Why anchor on the meters, not the trigger's label: the label and the
  // percent formatting are localized ("Utilisation", "41 % utilisé").
  const usageTrigger = orcaPage.locator('button', { has: activeMeter })
  await expect(usageTrigger).toContainText(/41\s?%/)
  await expect(usageTrigger).toContainText(/87\s?%/)
})

/**
 * Proves the rendered bar and popover stay honest when one account's quota refresh fails while
 * another keeps refreshing: the failing lane keeps its last good number, says how old it is and
 * why the refresh failed, and drops the number entirely once the window it measured has reset.
 */
test('distinguishes a healthy account from a rate-limited and an expired retained one', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)

  // Why: the host OS locale drives Orca's default UI language, and this spec asserts the
  // English status copy. Pin it so the locators are stable across dev machines and CI.
  await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().settings?.uiLanguage))
    .toBe('en')

  await orcaPage.evaluate(
    async ({ activeEmail, secondEmail, thirdEmail }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      await store.getState().ensureDetectedAgents()
      const previous = store.getState()
      if (!previous.settings) {
        throw new Error('settings are not hydrated yet')
      }
      const now = Date.now()
      const managedAccount = (id: string, email: string, order: number) => ({
        id,
        email,
        managedAuthPath: `/tmp/${id}/auth`,
        authMethod: 'subscription-oauth' as const,
        createdAt: order,
        updatedAt: order,
        lastAuthenticatedAt: order
      })
      store.setState({
        detectedAgentIds: ['claude'],
        statusBarItems: ['claude'],
        settings: {
          ...previous.settings,
          activeRuntimeEnvironmentId: null,
          activeClaudeManagedAccountId: 'account-active',
          activeClaudeManagedAccountIdsByRuntime: { host: 'account-active', wsl: {} },
          claudeManagedAccounts: [
            managedAccount('account-active', activeEmail, 1),
            managedAccount('account-second', secondEmail, 2),
            managedAccount('account-third', thirdEmail, 3)
          ]
        },
        rateLimits: {
          ...previous.rateLimits,
          // Healthy: refreshed just now, reset still ahead.
          claude: {
            provider: 'claude',
            session: {
              usedPercent: 41,
              windowMinutes: 300,
              resetsAt: now + 2 * 60 * 60_000,
              resetDescription: null
            },
            weekly: null,
            updatedAt: now,
            error: null,
            status: 'ok'
          },
          activeClaudeAccountId: 'account-active',
          activeCodexAccountId: null,
          claudeSystemDefault: null,
          codexSystemDefault: null,
          inactiveClaudeAccounts: [
            {
              accountId: 'account-second',
              updatedAt: now,
              isFetching: false,
              // 429 on the usage read: the previous sample is retained, updatedAt still dates
              // that sample, and the window it measured is still open.
              rateLimits: {
                provider: 'claude',
                session: {
                  usedPercent: 87,
                  windowMinutes: 300,
                  resetsAt: now + 2 * 60 * 60_000,
                  resetDescription: null
                },
                weekly: null,
                updatedAt: now - 12 * 60_000,
                error: 'HTTP 429 from the Claude usage endpoint',
                status: 'error',
                usageMetadata: { failureKind: 'rate-limited' }
              }
            },
            {
              accountId: 'account-third',
              updatedAt: now,
              isFetching: false,
              // Retained far longer than the window it measured: the quota period it described
              // has already rolled over, so the number is no longer a reading of anything.
              rateLimits: {
                provider: 'claude',
                session: {
                  usedPercent: 63,
                  windowMinutes: 300,
                  resetsAt: now - 60 * 60_000,
                  resetDescription: null
                },
                weekly: null,
                updatedAt: now - 20 * 60 * 60_000,
                error: 'HTTP 429 from the Claude usage endpoint',
                status: 'error',
                usageMetadata: { failureKind: 'rate-limited' }
              }
            }
          ]
        }
      })
    },
    { activeEmail: ACTIVE_EMAIL, secondEmail: SECOND_EMAIL, thirdEmail: THIRD_EMAIL }
  )

  const activeMeter = orcaPage.locator(`[title="${ACTIVE_EMAIL}"]`)
  const expiredMeter = orcaPage.locator(`[title="${THIRD_EMAIL}"]`)
  await expect(activeMeter).toBeVisible()
  await expect(expiredMeter).toBeVisible()
  const usageTrigger = orcaPage.locator('button', { has: activeMeter })

  // On the bar itself: both live readings survive, the reset-expired one is blanked on its
  // own segment — asserted positively, so a missing third lane cannot pass this.
  await expect(usageTrigger).toContainText(/41\s?%/)
  await expect(usageTrigger).toContainText(/87\s?%/)
  const expiredSegment = usageTrigger.locator('span').filter({ has: expiredMeter }).first()
  await expect(expiredSegment).toContainText('—')
  await expect(expiredSegment).not.toContainText(/63\s?%/)

  await usageTrigger.click()

  const healthyRow = orcaPage.locator('[data-usage-mode]').filter({ hasText: ACTIVE_EMAIL })
  const rateLimitedRow = orcaPage.locator('[data-usage-mode]').filter({ hasText: SECOND_EMAIL })
  const expiredRow = orcaPage.locator('[data-usage-mode]').filter({ hasText: THIRD_EMAIL })
  await expect(healthyRow).toBeVisible()
  await expect(rateLimitedRow).toBeVisible()
  await expect(expiredRow).toBeVisible()

  // The refreshing account reads as a plain current measurement.
  await expect(healthyRow).toContainText(/41\s?%/)
  await expect(healthyRow).not.toContainText('last read')
  await expect(healthyRow).not.toContainText('Refresh rate limited')

  // The throttled one keeps its number, dates it, and names the failure — and says nothing
  // about the subscription being spent.
  await expect(rateLimitedRow).toContainText(/87\s?%/)
  await expect(rateLimitedRow).toContainText('Refresh rate limited')
  await expect(rateLimitedRow).toContainText('last read 12m ago')

  // The expired one keeps the failure and the age but withholds the stale number.
  await expect(expiredRow).not.toContainText(/63\s?%/)
  await expect(expiredRow).toContainText('—')
  await expect(expiredRow).toContainText('Refresh rate limited')
  await expect(expiredRow).toContainText('last read 20h ago')

  await testInfo.attach('status-bar-stale-account-meters.png', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
})

// The failing lanes' French copy, verbatim from src/renderer/src/i18n/locales/fr.json.
// "En attente du renouvellement des identifiants" is the longest status sentence the bar can
// carry, and the one the user's screenshot wrapped on.
const FR_DEFERRED_LABEL = 'En attente du renouvellement des identifiants'
const FR_RATE_LIMITED_LABEL = 'Actualisation limitée par le serveur'
const FR_REFRESH_FAILED_LABEL = "Échec de l'actualisation"
// The status bar is one 24px row (`h-6 min-h-[24px]`); a wrapped label doubled it.
const STATUS_BAR_ROW_MAX_PX = 24
// A single 11px line plus the 6px meter and its leading; a second line lands well past this.
const SEGMENT_LINE_MAX_PX = 20
// Matches the `max-w-[72px]` bound on the bar's status label, plus subpixel headroom.
const STATUS_LABEL_MAX_PX = 74

/**
 * Proves the densest realistic roster stays on one line in a verbose locale: eight lanes — two
 * Claude accounts and Qwen all failing with no cached window, plus two Codex accounts, Grok,
 * Cursor and ClinePass still reporting — rendered in French at a real 1568px window.
 *
 * Why this fixture: French status copy ("En attente du renouvellement des identifiants") is four
 * times the English "Refresh failed", and the bar's label had no width bound, so the flex row
 * reflowed it and pushed every meter onto extra lines.
 *
 * Safety: every account, snapshot and failure is injected into the renderer store. The spec reads
 * no keychain and contacts no provider — there are no real credentials anywhere in it.
 */
test('keeps a dense French roster on a single status-bar line', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  // Why: compact kicks in under 900px of *status-bar* width. Pin both the Chromium
  // viewport and the BrowserWindow so the ResizeObserver sees a real 1568px bar.
  await orcaPage.setViewportSize({ width: 1568, height: 900 })
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1568, 900)
  })
  await waitForSessionReady(orcaPage)

  await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'fr' }))
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().settings?.uiLanguage))
    .toBe('fr')

  await orcaPage.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    await store.getState().ensureDetectedAgents()
    const previous = store.getState()
    if (!previous.settings) {
      throw new Error('settings are not hydrated yet')
    }
    const now = Date.now()
    const session = (usedPercent: number) => ({
      usedPercent,
      windowMinutes: 300,
      resetsAt: now + 2 * 60 * 60_000,
      resetDescription: null
    })
    const weekly = (usedPercent: number) => ({
      usedPercent,
      windowMinutes: 10_080,
      resetsAt: now + 3 * 24 * 60 * 60_000,
      resetDescription: null
    })
    // No window at all: the lane can only say why its refresh failed, which is the wrapping case.
    const failing = (
      provider: 'claude' | 'qwencloud',
      error: string,
      failureKind?: 'deferred-by-live-session' | 'rate-limited'
    ) => ({
      provider,
      session: null,
      weekly: null,
      updatedAt: now - 9 * 60_000,
      error,
      status: 'error' as const,
      ...(failureKind ? { usageMetadata: { failureKind } } : {})
    })
    const metered = (provider: 'codex' | 'grok' | 'cursor' | 'clinepass', usedPercent: number) => ({
      provider,
      session: session(usedPercent),
      weekly: null,
      updatedAt: now,
      error: null,
      status: 'ok' as const
    })
    store.setState({
      detectedAgentIds: ['claude', 'codex', 'grok'],
      statusBarItems: ['claude', 'codex', 'grok', 'cursor', 'clinepass', 'qwencloud'],
      statusBarUsageMode: 'verbose',
      settings: {
        ...previous.settings,
        activeRuntimeEnvironmentId: null,
        activeClaudeManagedAccountId: 'claude-1',
        activeClaudeManagedAccountIdsByRuntime: { host: 'claude-1', wsl: {} },
        claudeManagedAccounts: [
          {
            id: 'claude-1',
            email: 'claude-un@example.com',
            managedAuthPath: '/tmp/claude-1/auth',
            authMethod: 'subscription-oauth',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          },
          {
            id: 'claude-2',
            email: 'claude-deux@example.com',
            managedAuthPath: '/tmp/claude-2/auth',
            authMethod: 'subscription-oauth',
            createdAt: 2,
            updatedAt: 2,
            lastAuthenticatedAt: 2
          }
        ],
        activeCodexManagedAccountId: 'codex-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'codex-1', wsl: {} },
        codexManagedAccounts: [
          {
            id: 'codex-1',
            email: 'codex-un@example.com',
            managedHomePath: '/tmp/codex-1',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          },
          {
            id: 'codex-2',
            email: 'codex-deux@example.com',
            managedHomePath: '/tmp/codex-2',
            createdAt: 2,
            updatedAt: 2,
            lastAuthenticatedAt: 2
          }
        ]
      },
      rateLimits: {
        ...previous.rateLimits,
        // Both Claude lanes fail with nothing cached: the longest French sentence, twice.
        claude: failing(
          'claude',
          'Usage refresh deferred by a live Claude session',
          'deferred-by-live-session'
        ),
        codex: { ...metered('codex', 34), weekly: weekly(58) },
        gemini: null,
        opencodeGo: null,
        kimi: null,
        antigravity: null,
        minimax: null,
        grok: metered('grok', 12),
        cursor: metered('cursor', 71),
        clinepass: metered('clinepass', 5),
        qwencloud: failing('qwencloud', 'HTTP 500 from the Qwen usage endpoint'),
        grokAuthConfigured: true,
        codexbarAvailable: true,
        activeClaudeAccountId: 'claude-1',
        activeCodexAccountId: 'codex-1',
        claudeSystemDefault: null,
        codexSystemDefault: null,
        inactiveClaudeAccounts: [
          {
            accountId: 'claude-2',
            updatedAt: now,
            isFetching: false,
            rateLimits: failing('claude', 'HTTP 429 from the Claude usage endpoint', 'rate-limited')
          }
        ],
        inactiveCodexAccounts: [
          {
            accountId: 'codex-2',
            updatedAt: now,
            isFetching: false,
            rateLimits: { ...metered('codex', 62), weekly: weekly(19) }
          }
        ]
      }
    })
  })

  const usageTrigger = orcaPage.getByRole('button', { name: 'Utilisation', exact: true })
  await expect(usageTrigger).toBeVisible()
  // Two Claude lanes, two Codex lanes, Grok, Cursor, ClinePass, Qwen.
  const segments = usageTrigger.locator(':scope > span')
  await expect(segments).toHaveCount(8)

  // The regression in one number: the row's own height. A wrapped label made the trigger taller
  // than the bar it lives in.
  await expect
    .poll(async () => (await usageTrigger.boundingBox())?.height ?? Number.POSITIVE_INFINITY, {
      message: 'the usage cluster is taller than one status-bar row (labels are wrapping)'
    })
    .toBeLessThanOrEqual(STATUS_BAR_ROW_MAX_PX)

  const triggerBox = (await usageTrigger.boundingBox())!
  const segmentBoxes = await segments.evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, right: box.right, height: box.height }
    })
  )

  for (const box of segmentBoxes) {
    // Each lane is one line…
    expect(box.height).toBeLessThanOrEqual(SEGMENT_LINE_MAX_PX)
    // …all lanes share that line…
    expect(Math.abs(box.top - triggerBox.y)).toBeLessThanOrEqual(SEGMENT_LINE_MAX_PX)
    expect(box.bottom).toBeLessThanOrEqual(triggerBox.y + triggerBox.height + 1)
    // …and none of them runs off the window instead of wrapping.
    expect(box.right).toBeLessThanOrEqual(1568)
  }

  // The long sentence is bounded and ellipsized on the bar, with the full text on hover.
  const deferredLabel = usageTrigger.locator(`[title="${FR_DEFERRED_LABEL}"]`)
  await expect(deferredLabel).toBeVisible()
  expect((await deferredLabel.boundingBox())!.width).toBeLessThanOrEqual(STATUS_LABEL_MAX_PX)

  await testInfo.attach('status-bar-dense-french-roster.png', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })

  // Nothing is hidden: every failure is still spelled out in full in the Usage popover.
  await usageTrigger.click()
  const deferredRow = orcaPage
    .locator('[data-usage-mode]')
    .filter({ hasText: 'claude-un@example.com' })
  const rateLimitedRow = orcaPage
    .locator('[data-usage-mode]')
    .filter({ hasText: 'claude-deux@example.com' })
  await expect(deferredRow).toContainText(FR_DEFERRED_LABEL)
  await expect(rateLimitedRow).toContainText(FR_RATE_LIMITED_LABEL)
  await expect(orcaPage.locator('[data-usage-mode]').filter({ hasText: 'Qwen' })).toContainText(
    FR_REFRESH_FAILED_LABEL
  )
})
