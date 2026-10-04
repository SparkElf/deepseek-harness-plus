/** Full-stack Plus user-data Backup Host plugin. */

import { basename } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-workspace'
import { registerBackupRoutes, type BackupHostContext } from './routes.ts'

export const name = 'plus-backup'
export const inject = ['connection', 'webServer', 'settings', 'workspaceRegistry']

const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

/** Backup Host resource policy. */
export interface Config {
  /** Maximum uploaded ZIP bytes written to Host disk. @default 2147483648 */
  maxUploadBytes?: number
}

/** Validate Backup Host resource policy. */
export const Config: Schema<Config> = Schema.object({
  maxUploadBytes: Schema.number().step(1).min(1).default(DEFAULT_MAX_UPLOAD_BYTES),
})

/**
 * Register authenticated archive routes against the Harness home.
 *
 * The archived user data lives under the Harness home, not beside the settings document: Session
 * logs, attachments, Workspace storage, credentials, and identity are all written there. Only the
 * profile's patch file sits beside the document, so deriving the root from the document archived
 * that one file and silently dropped every other planned entry — a Sessions export produced an
 * archive holding nothing but its manifest.
 *
 * @param ctx - Host services plus the temporary patched Workspace restore operation.
 * @param config - Upload resource policy resolved by Cordis.
 */
export function apply(ctx: BackupHostContext, config: Config = {}): void {
  const documentPath = ctx.settings.documentPath
  if (documentPath === undefined) throw new Error('plus-backup requires a file-backed settings provider')
  registerBackupRoutes(ctx, {
    maxUploadBytes: config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
    settingsFile: basename(documentPath),
  }, resolveDshHome())
}
