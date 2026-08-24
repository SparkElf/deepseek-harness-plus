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
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
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

const NS = 'settingsBackup'
export const inject = ['slots', 'locale', 'connection']

/** Resolve a Host logical path beneath the runtime-injected document base. */
function browserHostUrl(path: string): string {
  const base = typeof document === 'undefined' ? 'http://dsh.internal/' : document.baseURI
  return new URL(path.replace(/^\//u, ''), base).toString()
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-backup: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const injected = (): BackupSectionInjected => ({
    exportArchive: async () => {
      const { result } = await connection.api.settings.backupExport({})
      if (!result.ok) throw new Error(result.error.message)
      return {
        ...result.value,
        downloadUrl: browserHostUrl(result.value.downloadUrl),
      }
    },
    importArchive: async (file: File) => {
      const upload = await fetch(browserHostUrl('/api/backup.upload'), { method: 'POST', body: file })
      if (!upload.ok) throw new Error('backup upload failed')
      const { token } = await upload.json() as { token: string }
      const { result } = await connection.api.settings.backupImport({ token })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'backup',
    order: 30,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: injected,
  }, BackupSection))
}