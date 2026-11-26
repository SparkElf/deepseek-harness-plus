/**
 * Deployment-level settings for a LOCAL knowledge deployment.
 *
 * These values cannot live under `mountPoint`: the local mount point IS the
 * configured storage root, so reading the setting from there would make the
 * default impossible to discover after the operator points it somewhere else.
 * A small file under `$DSH_HOME` breaks that cycle. It contains no credentials
 * and no document content, only the one path the Settings page owns.
 *
 * @module @sparkelf/dsh-knowledge-base/local-storage-settings
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveStorageRoot } from './localStoragePath.ts'

/** The local deployment fields the Settings page may change. */
export interface LocalStorageSettings {
  /** Authoritative root, absolute or `~/...`. */
  storageRoot?: string
}

/** Path of the profile-local settings file. */
export function localStorageSettingsPath(home = homedir(), dshHome = process.env.DSH_HOME): string {
  const base = dshHome?.trim() !== '' && dshHome !== undefined ? dshHome : join(home, '.dsh')
  return join(base, 'knowledge-base-storage.json')
}

/**
 * Read the local settings file, tolerating absence/corruption.
 * @returns The stored fields, empty when nothing usable exists.
 */
export async function readLocalStorageSettings(): Promise<LocalStorageSettings> {
  let raw: string
  try {
    raw = await readFile(localStorageSettingsPath(), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object') return {}
    return typeof parsed.storageRoot === 'string' && parsed.storageRoot.trim() !== ''
      ? { storageRoot: parsed.storageRoot.trim() }
      : {}
  } catch {
    return {}
  }
}

/**
 * Store one storage-root choice atomically.
 *
 * The value is validated by the same resolver the view builder uses, so a
 * relative path is rejected at write time rather than becoming a process-cwd
 * surprise on the next restart.
 * @param storageRoot - new root, absolute or `~/...`.
 * @returns The normalised value actually written.
 */
export async function writeLocalStorageRoot(storageRoot: string): Promise<string> {
  const normalized = resolveStorageRoot(storageRoot)
  const target = localStorageSettingsPath()
  await mkdir(dirname(target), { recursive: true })
  const temporary = target + '.tmp'
  await writeFile(temporary, JSON.stringify({ storageRoot: normalized }), 'utf8')
  await rename(temporary, target)
  return normalized
}
