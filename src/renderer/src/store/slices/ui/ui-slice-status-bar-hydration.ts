import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'
import { migrateStatusBarItems } from './ui-slice-hydration-sanitizers'

// Why: a one-shot flag per rollout adds its items to an existing bar once, so a user who later hides one stays hidden.
const DEFAULT_ON_STATUS_BAR_ITEMS = [
  ['_portsStatusBarDefaultAdded', ['ports']],
  ['_kimiStatusBarDefaultAdded', ['kimi']],
  ['_minimaxStatusBarDefaultAdded', ['minimax']],
  ['_antigravityStatusBarDefaultAdded', ['antigravity']],
  ['_grokStatusBarDefaultAdded', ['grok']],
  // Why: the two CodexBar-metered providers share one durable signal (the codexbar binary), hence one flag.
  ['_codexBarStatusBarDefaultAdded', ['cursor', 'qwencloud']]
] as const satisfies readonly (readonly [keyof PersistedUIState, readonly StatusBarItem[]])[]

export function hydrateStatusBarItems(ui: PersistedUIState): StatusBarItem[] {
  let items = migrateStatusBarItems(ui.statusBarItems)
  for (const [flag, added] of DEFAULT_ON_STATUS_BAR_ITEMS) {
    if (ui[flag]) {
      continue
    }
    for (const item of added) {
      if (!items.includes(item)) {
        items = [...items, item]
      }
    }
  }
  if (typeof window !== 'undefined' && DEFAULT_ON_STATUS_BAR_ITEMS.some(([flag]) => !ui[flag])) {
    window.api.ui
      .set({
        statusBarItems: items,
        ...Object.fromEntries(DEFAULT_ON_STATUS_BAR_ITEMS.map(([flag]) => [flag, true]))
      })
      .catch(console.error)
  }
  return items
}
