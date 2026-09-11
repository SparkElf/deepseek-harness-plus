/**
 * Registry queries behind the `update` command.
 *
 * A standalone installation pins one exact distribution version, so it needs two
 * facts npm's own updater cannot give it: which versions exist, and which of them is
 * newer than the one installed. `pnpm update` treats an exact pin as a range of one
 * and always reports "already up to date".
 */

import { execFileSync } from 'node:child_process'
import semver from 'semver'

/** One published version with the time the registry recorded for it. */
export interface PublishedVersion {
  /** Published version. */
  readonly version: string
  /** Publication time in ISO form, when the registry reports one. */
  readonly publishedAt?: string
}

/** Every published version of one package, oldest first, with publication times. */
export function publishedVersions(name: string, registry = 'https://registry.npmjs.org'): PublishedVersion[] {
  let raw: string
  try {
    raw = execFileSync('npm', ['view', name, 'time', '--json', '--registry', registry], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const times = parsed as Record<string, unknown>
  const entries: PublishedVersion[] = []
  for (const [version, time] of Object.entries(times)) {
    // `created` and `modified` are registry bookkeeping, not releases.
    if (version === 'created' || version === 'modified') continue
    if (semver.valid(version) === null) continue
    entries.push(typeof time === 'string' ? { version, publishedAt: time } : { version })
  }
  return entries.sort((left, right) => semver.compare(left.version, right.version))
}

/**
 * The highest published version that is newer than the installed one.
 *
 * Prerelease ordering matters here: an installation on a release candidate must not
 * be told that an older stable release is an upgrade, and must be told about a newer
 * candidate.
 *
 * @param name - package to query.
 * @param installed - version currently installed.
 * @param registry - registry to query.
 * @returns the newer version, or undefined when the installation is current.
 */
export function newerVersion(name: string, installed: string, registry = 'https://registry.npmjs.org'): PublishedVersion | undefined {
  const candidates = publishedVersions(name, registry)
    .filter(entry => semver.gt(entry.version, installed))
  return candidates.at(-1)
}
