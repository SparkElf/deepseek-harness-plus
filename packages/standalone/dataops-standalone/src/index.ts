/**
 * The standalone DataOps workspace distribution.
 *
 * This package exists to be installed, not to be called: its manifest pins the
 * distribution and its runtime without the capabilities an intranet workspace must not
 * run, and the profile it needs is written by \`dsh-plus start\`.
 *
 * @module @sparkelf/dsh-dataops-standalone
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Profile this installation owns. */
export const PROFILE = 'dataops-web'

/** Distribution package this installation pins. */
export const DISTRIBUTION = '@sparkelf/dsh-plus'

/**
 * Capabilities this variant omits, which an intranet workspace must not run.
 *
 * The list restates the distribution's own \`standaloneVariants.dataops.excludePackages\`
 * so a consumer or a gate can assert the reduction without parsing that manifest.
 */
export const EXCLUDED_PACKAGES: readonly string[] = [
  '@deepseek-ai/dsh-computer-use',
  '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp',
  '@deepseek-ai/dsh-web-search-exa',
]

/**
 * Official runtime version this installation targets.
 *
 * @returns the pinned \`@deepseek-ai/dsh\` version.
 */
export function runtimeVersion(): string {
  const manifest = JSON.parse(readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), '../../package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const pinned = manifest.dependencies?.['@deepseek-ai/dsh']
  if (pinned === undefined) throw new Error('the standalone manifest pins no @deepseek-ai/dsh version')
  return pinned
}
