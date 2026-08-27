import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const ACTIVE_EMAIL = 'active-account@example.com'
const SECOND_EMAIL = 'second-account@example.com'

/**
 * Proves the rendered status bar carries one meter per Claude account rather than only the
 * active one. State is injected through the renderer store: provisioning two real OAuth
 * logins is not needed to exercise the lane build and its DOM.
 */
test('renders one status-bar meter per provider account', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)

  await orcaPage.evaluate(
    ({ activeEmail, secondEmail }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
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
        // Why: CLI detection gating hides the Claude meter when no claude binary is on PATH.
        detectedAgentIds: null,
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
  const usageTrigger = orcaPage.getByRole('button', { name: 'Usage' })
  await expect(usageTrigger).toContainText('41%')
  await expect(usageTrigger).toContainText('87%')
})
