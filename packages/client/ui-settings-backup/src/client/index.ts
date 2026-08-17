/**
 * Settings Backup section plugin, browser half: registers the `settings.section`
 * entry (id `backup`) whose page exports and imports the user settings and data
 * as one zip archive. The archive itself streams over the Host-only
 * `/api/backup.export` / `/api/backup.upload` routes; the RPC pair carries only
 * a download URL and an upload token, never archive bytes.
 * Export discipline: packages/client/AGENTS.md.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the settings slot declarations (settings.section) and the
// ctx.settingsScope Context merge. Cross-plugin collaboration goes through
// the slot system, never a value import.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BackupSection, type BackupSectionInjected } from './BackupSection.tsx'
import { en, zh, type SettingsBackupKey } from './locales.ts'

export type { BackupSectionInjected, BackupSectionProps } from './BackupSection.tsx'
export type { SettingsBackupKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Backup section copy. */
    settingsBackup: SettingsBackupKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settingsBackup'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the `settingsBackup` dictionaries and the Backup section entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-backup: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const injected = (): BackupSectionInjected => ({
    exportArchive: async () => {
      const { result } = await connection.api.settings.backupExport({})
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    importArchive: async (file: File) => {
      const upload = await fetch('/api/backup.upload', { method: 'POST', body: file })
      if (!upload.ok) throw new Error('backup upload failed')
      const { token } = await upload.json() as { token: string }
      const { result } = await connection.api.settings.backupImport({ token })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
  })
  // Ordered after the feature sections: backup is a data-safety net, not a
  // deployment-shaping page.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'backup',
    order: 30,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: injected,
  }, BackupSection))
}
