import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export type StatusBarToggleSearchEntry = {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
}

// Extracted rather than inlined in appearance-status-bar-search.ts: that file sits at the
// max-lines budget, and all three providers are metered by the one CodexBar CLI anyway.
export function getCodexBarStatusBarToggleSearchEntries(): readonly StatusBarToggleSearchEntry[] {
  const statusBarKeyword = translateSearchKeyword(
    'auto.components.settings.appearance.search.896eb53fd4',
    'status bar'
  )
  const usageKeyword = translateSearchKeyword(
    'auto.components.settings.appearance.search.00a028f25f',
    'usage'
  )
  const subscriptionKeyword = translateSearchKeyword(
    'auto.components.settings.appearance.search.de586def95',
    'subscription'
  )
  const codexbarKeyword = translateSearchKeyword(
    'auto.components.settings.appearance.search.2cf90681da',
    'codexbar'
  )
  return [
    {
      id: 'cursor',
      title: translate('auto.components.settings.appearance.search.a3f1c07d92', 'Cursor Usage'),
      description: translate(
        'auto.components.settings.appearance.search.d7a4b13c85',
        'Show Cursor subscription usage in the status bar.'
      ),
      keywords: [
        ...statusBarKeyword,
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.e8b5c24d96',
          'cursor'
        ),
        ...usageKeyword,
        ...subscriptionKeyword,
        ...codexbarKeyword
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.cursorToggleDescription',
        'Show Cursor subscription usage reported by the CodexBar CLI.'
      )
    },
    {
      id: 'clinepass',
      title: translate('auto.components.settings.appearance.search.b4e2d18a63', 'ClinePass Usage'),
      description: translate(
        'auto.components.settings.appearance.search.f9c6d35ea7',
        'Show ClinePass subscription usage in the status bar.'
      ),
      keywords: [
        ...statusBarKeyword,
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.0ad7e46fb8',
          'clinepass'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.1be8f570c9', 'cline'),
        ...usageKeyword,
        ...subscriptionKeyword,
        ...codexbarKeyword
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.clinePassToggleDescription',
        'Show ClinePass subscription usage reported by the CodexBar CLI.'
      )
    },
    {
      id: 'qwencloud',
      title: translate('auto.components.settings.appearance.search.c5d3e29b74', 'Qwen Cloud Usage'),
      description: translate(
        'auto.components.settings.appearance.search.3da17692eb',
        'Show Qwen Cloud subscription usage in the status bar.'
      ),
      keywords: [
        ...statusBarKeyword,
        ...translateSearchKeyword('auto.components.settings.appearance.search.4eb287a3fc', 'qwen'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.5fc398b40d',
          'alibaba'
        ),
        ...usageKeyword,
        ...subscriptionKeyword,
        ...codexbarKeyword
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.qwenCloudToggleDescription',
        'Show Qwen Cloud subscription usage reported by the CodexBar CLI.'
      )
    }
  ]
}
