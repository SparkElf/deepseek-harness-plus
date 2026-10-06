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

/** How long one registry query may stay pending before the override pass gives up on it. */
const NPM_VIEW_TIMEOUT_MS = 20_000

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
      // A stalled registry connection otherwise blocks on npm's own 300s fetch-timeout and then
      // its two retries; measured once at 7 minutes for a single `view` while the same command
      // answered in 0.9s by hand. The gate runs one of these per third-party plugin.
      timeout: NPM_VIEW_TIMEOUT_MS,
    })
    if (raw.trim() === '') return {}
    const parsed = JSON.parse(raw) as unknown
    // npm answers one object per matching version, so a single spec arrives wrapped in
    // an array; treating that array as unusable silently drops every peer it carries.
    const entries = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed]
    const record: unknown = entries[0]
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return {}
    const peers: Record<string, string> = {}
    for (const [name, range] of Object.entries(record as Record<string, unknown>)) peers[name] = String(range)
    return peers
  } catch {
    return {}
  }
}

/**
 * The runtime version when the package published it, otherwise the newest version its peer range
 * admits. One official package can lag its family, and pinning it to a version that was never
 * published makes the whole install unresolvable.
 * @param name - Package to resolve.
 * @param runtimeVersion - Version the runtime family ships.
 * @param range - Range the plugin declared for this package.
 * @param registry - Registry to query.
 * @returns A version to override to, falling back to the newest published one.
 */
function publishedOrHighest(
  name: string,
  runtimeVersion: string,
  range: string,
  registry: string,
): string | undefined {
  const versions = publishedVersions(name, registry)
  if (versions.includes(runtimeVersion)) return runtimeVersion
  const admits = versions.filter(entry => semver.satisfies(entry, range, { includePrerelease: true }))
  return (admits.length > 0 ? admits : versions).sort(semver.rcompare)[0]
}

/**
 * Whether one package published one exact version.
 *
 * The override pass derives versions from the registry, so a version it names that no registry
 * serves is a defect in the derivation rather than a fact about the package. Exported so a test can
 * assert that for every override the pass produces.
 * @param name - Package to query.
 * @param version - Version the override names.
 * @param registry - Registry to query.
 * @returns True when that exact version is published.
 */
export function isPublishedVersion(name: string, version: string, registry = 'https://registry.npmjs.org'): boolean {
  return publishedVersions(name, registry).includes(version)
}

/**
 * Every published version of one package, oldest-major-agnostic order as the registry returns it.
 * @param name - Package to query.
 * @param registry - Registry to query.
 * @returns The versions, or an empty list when the query fails.
 */
function publishedVersions(name: string, registry: string): string[] {
  try {
    const raw = execFileSync('npm', ['view', name, 'versions', '--json', '--registry', registry], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: NPM_VIEW_TIMEOUT_MS,
    })
    const parsed: unknown = JSON.parse(raw)
    return (Array.isArray(parsed) ? parsed : [parsed]).map(String).filter(entry => semver.valid(entry) !== null)
  } catch {
    return []
  }
}

/** Highest published version of one package, preferring a match for a target range. */
function resolveVersion(name: string, range: string | undefined, registry: string): string | undefined {
  const versions = publishedVersions(name, registry)
  if (versions.length === 0) return undefined
  const candidates = range === undefined
    ? versions
    : versions.filter(entry => semver.satisfies(entry, range, { includePrerelease: true }))
  const usable = candidates.length > 0 ? candidates : versions
  return usable.sort(semver.rcompare)[0]
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
  pinned: Readonly<Record<string, string>> = {},
): PeerOverride[] {
  const overrides = new Map<string, PeerOverride>()
  for (const plugin of plugins) {
    for (const [name, range] of Object.entries(publishedPeers(plugin, registry))) {
      if (!name.startsWith('@deepseek-ai/dsh-') && !name.startsWith('@huanlin/') && name !== 'dsh-better-sidebar') continue
      if (semver.satisfies(runtimeVersion, range)) continue
      if (semver.valid(semver.coerce(range) ?? '') !== null && semver.satisfies(runtimeVersion, range)) continue
      if (overrides.has(name)) continue
      // A package the manifest already depends on directly must be overridden to the
      // version that dependency pins: npm rejects an override that names any other
      // version, and a different one would install a second copy besides.
      // A package the runtime family published is pinned to the runtime version, because the
      // official packages are released together. One is not: the official `dsh-invariants` stayed
      // at 0.2.0-rc.2 while the rest moved to 0.2.1-alpha.1, so taking the runtime version produced
      // an override npm could not resolve at all -- and only when something asked for that peer,
      // which is why it survived until a profile installed peers. Falling back to the newest
      // published version that satisfies the plugin's own range keeps this derived rather than
      // recorded, and a release that does publish the runtime version still takes it.
      const version = pinned[name]
        ?? (name.startsWith('@deepseek-ai/')
          ? publishedOrHighest(name, runtimeVersion, range, registry)
          : resolveVersion(name, undefined, registry))
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
