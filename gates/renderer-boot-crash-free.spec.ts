import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

type PersistedCrashReport = {
  createdAt?: string
  details?: { boundary_id?: string; error_name?: string; error_message?: string }
}

/**
 * Boot the built renderer against a seeded repo and prove no error boundary fired.
 *
 * Why an e2e and not a unit test: the unit suites mock `@/store`, so a selector that
 * allocates its snapshot never loops there. In the real app it is React #185 at first
 * mount of the status bar (fork build 6feef259b9f5), which only the packaged renderer
 * shows. The crash store is the same file production writes, so a boundary that fired
 * before Playwright attached its listeners still counts.
 */
test('boots without a render boundary crash', async ({ electronApp, orcaPage }) => {
  const pageErrors: string[] = []
  orcaPage.on('pageerror', (error) => pageErrors.push(error.message))

  await waitForSessionReady(orcaPage)
  // Why: a boundary report travels renderer -> IPC -> store before it lands on disk.
  await orcaPage.waitForTimeout(3_000)

  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const crashReportsPath = path.join(userDataDir, 'crash-reports.json')
  const reports: PersistedCrashReport[] = existsSync(crashReportsPath)
    ? (JSON.parse(readFileSync(crashReportsPath, 'utf-8')).reports ?? [])
    : []
  const boundaryCrashes = reports.map(
    (report) =>
      `${report.details?.boundary_id ?? '?'}: ${report.details?.error_name ?? '?'} ${report.details?.error_message ?? ''}`
  )

  expect(boundaryCrashes, 'render boundaries that fired during boot').toEqual([])
  expect(pageErrors, 'uncaught renderer errors during boot').toEqual([])
})
