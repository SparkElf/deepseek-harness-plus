/** Supervisor manifest loading and status publication. */

import { readFile } from 'node:fs/promises'
import { renameSync, writeFileSync } from 'node:fs'

/**
 * Load the explicit command and runtime paths used by one Supervisor process.
 * @param {string} manifestPath - manifest JSON path.
 * @returns {Promise<object>} parsed manifest.
 */
export async function readSupervisorManifest(manifestPath) {
  return JSON.parse(await readFile(manifestPath, 'utf8'))
}

/**
 * Publish the complete Supervisor manifest.
 * @param {string} manifestPath - manifest JSON path.
 * @param {string} content - complete status-bearing JSON text.
 * @returns {void}
 */
export function writeSupervisorManifest(manifestPath, content) {
  const nextPath = manifestPath + '.next'
  writeFileSync(nextPath, content)
  renameSync(nextPath, manifestPath)
}
