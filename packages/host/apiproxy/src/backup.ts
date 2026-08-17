/**
 * User data backup core for the web settings Backup section. The archive
 * covers the harness home (settings incl. provider/model configuration,
 * credentials with key values, storages) plus a manifest marker; runtime-
 * generated directories are excluded and archives validate before mutation.
 * Zip handling rides the package's existing fflate dependency; archives move
 * as files and byte buffers, never base64-in-JSON, so large homes do not
 * multiply through string encodings on either side of the wire.
 */

import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Manifest entry at the archive root; import validation uses it as the marker. */
export const BACKUP_MANIFEST_ENTRY = 'backup-manifest.json'

/** Runtime-generated harness-home directories that are not user configuration or data. */
const GENERATED_DIRECTORIES = new Set(['profiles', 'supervisor'])

/**
 * Recursively collect a directory's regular files into a zippable map with
 * slash-separated entry names. Symlinks and other non-regular entries are
 * skipped: runtime links are not portable and user configuration and data
 * are regular files.
 * @param files - zippable entry map under construction.
 * @param rootPath - walk root.
 * @param relativePath - current path relative to the root; empty at the root.
 * @returns nothing; mutates the entry map.
 */
function addDirectoryToZip(files: Zippable, rootPath: string, relativePath: string): void {
  const entries = readdirSync(join(rootPath, relativePath), { withFileTypes: true })
  for (const entry of entries) {
    const entryRelative = relativePath === '' ? entry.name : relativePath + '/' + entry.name
    if (entry.isDirectory()) {
      if (relativePath === '' && GENERATED_DIRECTORIES.has(entry.name)) continue
      files[entryRelative + '/'] = new Uint8Array(0)
      addDirectoryToZip(files, rootPath, entryRelative)
    } else if (entry.isFile()) {
      files[entryRelative] = new Uint8Array(readFileSync(join(rootPath, relativePath, entry.name)))
    }
  }
}

/**
 * Pack the harness home's user configuration and data into a zip archive
 * written at `targetPath`.
 * @param dshHome - harness user data directory (settings.yaml parent).
 * @param targetPath - absolute file path the archive is written to.
 * @returns the number of zip entries including the manifest marker.
 */
export function writeUserBackup(dshHome: string, targetPath: string): { entries: number } {
  const files: Zippable = {}
  addDirectoryToZip(files, dshHome, '')
  const manifest = {
    app: 'deepseek-harness',
    kind: 'user-data-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
  }
  files[BACKUP_MANIFEST_ENTRY] = strToU8(JSON.stringify(manifest, null, 2) + String.fromCharCode(10))
  writeFileSync(targetPath, Buffer.from(zipSync(files)))
  return { entries: Object.keys(files).length }
}

/** An archive that passed marker and path-safety validation, decompressed in memory. */
export interface ValidatedUserBackup {
  /** Entry name to content; directory entries carry a trailing slash. */
  entries: Record<string, Uint8Array>
  /** Number of zip entries including the manifest marker. */
  count: number
}

/**
 * Decompress and validate archive bytes without touching the harness home:
 * the marker must be present and every entry path must be relative, slash-
 * separated, and free of traversal segments.
 * @param archive - raw zip bytes.
 * @returns the decompressed, validated entries.
 */
export function validateUserBackup(archive: Uint8Array): ValidatedUserBackup {
  const entries = unzipSync(archive)
  const names = Object.keys(entries)
  if (!names.includes(BACKUP_MANIFEST_ENTRY)) {
    throw new Error('Not a DeepSeek Harness user data backup: missing ' + BACKUP_MANIFEST_ENTRY)
  }
  for (const name of names) {
    if (name.startsWith('/') || name.includes('\\')) throw new Error('Backup archive contains an unsafe path: ' + name)
    const parts = name.split('/')
    for (const [index, part] of parts.entries()) {
      if (part === '..') throw new Error('Backup archive contains an unsafe path: ' + name)
      if (part === '' && index < parts.length - 1) throw new Error('Backup archive contains an unsafe path: ' + name)
    }
  }
  return { entries, count: names.length }
}

/**
 * Write a validated archive's entries over the harness home; same-named
 * files are replaced, other files are kept.
 * @param validated - validateUserBackup result.
 * @param dshHome - harness user data directory.
 * @returns the restored entry count.
 */
export function restoreUserBackup(validated: ValidatedUserBackup, dshHome: string): { entries: number } {
  for (const [name, data] of Object.entries(validated.entries)) {
    if (name.endsWith('/')) {
      mkdirSync(join(dshHome, name), { recursive: true })
      continue
    }
    const target = join(dshHome, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
  }
  return { entries: validated.count }
}
