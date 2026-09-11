/**
 * The standalone Plus distribution.
 *
 * This package exists to be installed, not to be called: its manifest pins the
 * distribution and its runtime, and the profile it needs is written by `dsh-plus
 * start`. The module exports the two facts a consumer or a gate may want to read
 * without parsing the distribution's own manifest.
 *
 * @module @sparkelf/dsh-plus-standalone
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Profile this installation owns. */
export const PROFILE = 'plus'

/** Distribution package this installation pins. */
export const DISTRIBUTION = '@sparkelf/dsh-plus'

/**
 * Official runtime version this installation targets.
 *
 * @returns the pinned `@deepseek-ai/dsh` version.
 */
export function runtimeVersion(): string {
  const manifest = JSON.parse(readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), '../../package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const pinned = manifest.dependencies?.['@deepseek-ai/dsh']
  if (pinned === undefined) throw new Error('the standalone manifest pins no @deepseek-ai/dsh version')
  return pinned
}
