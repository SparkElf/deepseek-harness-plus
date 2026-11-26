/**
 * Resolve the personal knowledge-base storage root.
 *
 * `~` and `~/...` are accepted because the setting's default is expressed that
 * way; every other value must already be absolute. Relative paths are refused
 * instead of being resolved against the DSH process cwd.
 *
 * @module @sparkelf/dsh-knowledge-base/local-storage-path
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Directory holding the authoritative files under the storage root. */
export const STORAGE_ACTUAL_DIR = 'actual'

/** Expand the UI's storage path into an absolute storage base. */
export function resolveStorageRoot(raw: string, home = homedir()): string {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error('knowledge-base: storage path must not be empty')
  if (trimmed === '~') return resolve(home)
  if (trimmed.startsWith('~/')) return resolve(join(home, trimmed.slice(2)))
  if (!isAbsolute(trimmed)) {
    throw new Error(`knowledge-base: storage path must be absolute or start with ~/: ${JSON.stringify(trimmed)}`)
  }
  return resolve(trimmed)
}

/** The authoritative `actual/` directory for a storage base. */
export function storageActualRoot(storageRoot: string): string {
  return join(storageRoot, STORAGE_ACTUAL_DIR)
}
