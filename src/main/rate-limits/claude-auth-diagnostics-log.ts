import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

// Why: packaged main-process console.warn goes nowhere, which left a 19h
// refresh-failure loop unattributable in the field. Auth events land in an
// append-only ndjson under the app's logs dir instead.
const LOG_FILE = 'claude-auth-diagnostics.ndjson'
const MAX_LOG_BYTES = 2 * 1024 * 1024

export function logClaudeAuthDiagnostic(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {}
): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, LOG_FILE)
    try {
      if (statSync(file).size > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`)
      }
    } catch {
      // First write, or rotation raced another writer — both fine.
    }
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`)
  } catch {
    // Why: diagnostics must never break an auth or usage path.
  }
}
