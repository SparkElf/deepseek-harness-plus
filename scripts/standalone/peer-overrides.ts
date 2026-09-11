/**
 * Resolve the overrides a standalone install needs against the runtime it targets.
 *
 * Three published plugins declare peer ranges that cannot match the runtime the
 * distribution ships: one names its dependency with a caret over a 0.x range, which
 * admits only the first minor, and two cap a peer below the shipped version. npm
 * resolves such a graph with ERESOLVE and installs nothing.
 *
 * An override is a compatibility decision made on a third party's behalf, so this
 * module derives it from the registry rather than recording a hand-written list: a
 * range that already admits the runtime produces no override, and a package that
 * fixes its range loses ours on the next generation.
 */

import { execFileSync } from 'node:child_process'
import semver from 'semver'

/** One override, with the reason that produced it. */
export interface PeerOverride {
  /** Package whose resolution the override forces. */
  readonly name: string
  /** Version the override selects. */
  readonly version: string
  /** Why the declared range could not be satisfied. */
  readonly reason: string
}

/** Peer ranges one published plugin declares, limited to the official DSH family and named plugins. */
function publishedPeers(spec: string, registry: string): Record<string, string> {
  try {
    const raw = execFileSync('npm', ['view', spec, 'peerDependencies', '--json', '--registry', registry], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (raw.trim() === '') return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const peers: Record<string, string> = {}
    for (const [name, range] of Object.entries(parsed as Record<string, unknown>)) peers[name] = String(range)
    return peers
  } catch {
    return {}
  }
}

/** Highest published version of one package, preferring a match for a target range. */
function resolveVersion(name: string, range: string | undefined, registry: string): string | undefined {
  try {
    const raw = execFileSync('npm', ['view', name, 'versions', '--json', '--registry', registry], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed: unknown = JSON.parse(raw)
    const versions = (Array.isArray(parsed) ? parsed : [parsed]).map(String).filter(entry => semver.valid(entry) !== null)
    const candidates = range === undefined
      ? versions
      : versions.filter(entry => semver.satisfies(entry, range, { includePrerelease: true }))
    const usable = candidates.length > 0 ? candidates : versions
    return usable.sort(semver.rcompare)[0]
  } catch {
    return undefined
  }
}

/**
 * Derive the overrides one plugin set needs for one runtime version.
 *
 * @param plugins - published plugin specs, such as `name@1.2.3`.
 * @param runtimeVersion - official runtime the distribution ships.
 * @param registry - registry to query.
 * @returns one override per unsatisfiable peer, keyed by package name.
 */
export function resolvePeerOverrides(
  plugins: readonly string[],
  runtimeVersion: string,
  registry = 'https://registry.npmjs.org',
): PeerOverride[] {
  const overrides = new Map<string, PeerOverride>()
  for (const plugin of plugins) {
    for (const [name, range] of Object.entries(publishedPeers(plugin, registry))) {
      if (!name.startsWith('@deepseek-ai/dsh-') && !name.startsWith('@huanlin/') && name !== 'dsh-better-sidebar') continue
      if (semver.satisfies(runtimeVersion, range)) continue
      if (semver.valid(semver.coerce(range) ?? '') !== null && semver.satisfies(runtimeVersion, range)) continue
      if (overrides.has(name)) continue
      // 对 DSH 运行时包直接钉到运行时版本；对第三方包取满足该 peer 族的最高版本。
      const version = name.startsWith('@deepseek-ai/')
        ? runtimeVersion
        : resolveVersion(name, undefined, registry)
      if (version === undefined) continue
      overrides.set(name, {
        name,
        version,
        reason: plugin + ' declares ' + range + ', which ' + runtimeVersion + ' does not satisfy',
      })
    }
  }
  return [...overrides.values()]
}
