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
