/**
 * Derive the standalone distribution manifest from the Plus distribution.
 *
 * The Plus distribution already owns the reviewed bundle order and the exact plugin
 * pins. A standalone consumer installs from the registry alone and owns its own
 * profile, so it needs the same two facts expressed where npm and the launcher can
 * read them: every plugin as an ordinary dependency, and the bundle order as the
 * profile manifest the launcher writes on first start.
 *
 * Keeping one generator means a plugin added to the distribution cannot reach the
 * standalone package without also reaching its bundle order.
 *
 * Usage: tsx scripts/standalone/generate-manifest.ts --distribution <dir> --out <file>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolvePeerOverrides } from './peer-overrides.ts'

/** One reviewed runtime package the distribution pins exactly. */
interface ProfileDependency {
  readonly name: string
  readonly spec: string
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object')
  return value as Record<string, unknown>
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error(label + ' must be a string array')
  return value as string[]
}

/** Read the reviewed bundle order and exact pins from one Plus distribution. */
export function readDistribution(directory: string): {
  readonly name: string
  readonly version: string
  readonly dshRange: string
  readonly bundles: readonly string[]
  readonly dependencies: readonly ProfileDependency[]
  readonly allowBuilds: Readonly<Record<string, boolean>>
} {
  const manifest = requireRecord(JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as unknown, 'distribution manifest')
  const plus = requireRecord(manifest.dshPlus, 'dshPlus')
  const profile = requireRecord(plus.profile, 'dshPlus.profile')
  const compatibility = requireRecord(plus.compatibility, 'dshPlus.compatibility')
  const rawDependencies = requireRecord(profile.dependencies, 'dshPlus.profile.dependencies')
  const rawAllowBuilds = requireRecord(profile.allowBuilds, 'dshPlus.profile.allowBuilds')
  const allowBuilds: Record<string, boolean> = {}
  for (const [name, allowed] of Object.entries(rawAllowBuilds)) {
    if (typeof allowed !== 'boolean') throw new Error('dshPlus.profile.allowBuilds.' + name + ' must be a boolean')
    allowBuilds[name] = allowed
  }
  const dependencies = Object.entries(rawDependencies).map(([name, spec]) => {
    if (typeof spec !== 'string' || spec === '') throw new Error('dshPlus.profile.dependencies.' + name + ' must be a non-empty string')
    return { name, spec }
  })
  // The distribution also declares external runtime packages as ordinary dependencies,
  // and a bundle the standalone manifest omits cannot be resolved from the profile at
  // all, so every published external dependency has to reach the manifest.
  const runtimeDependencies = Object.entries(requireRecord(manifest.dependencies, 'distribution dependencies'))
    .filter(([name, spec]) => !String(spec).startsWith('workspace:') && !name.startsWith('@sparkelf/dsh-patch-'))
    .map(([name, spec]) => ({ name, spec: String(spec) }))
  const merged = new Map<string, ProfileDependency>()
  for (const entry of [...dependencies, ...runtimeDependencies]) merged.set(entry.name, entry)
  return {
    name: String(manifest.name),
    version: String(manifest.version),
    dshRange: String(compatibility.dsh),
    bundles: requireStringArray(profile.bundles, 'dshPlus.profile.bundles'),
    dependencies: [...merged.values()],
    allowBuilds,
  }
}

function main(): void {
  const { values } = parseArgs({
    options: {
      distribution: { type: 'string' },
      out: { type: 'string' },
      'runtime-version': { type: 'string' },
      'skip-overrides': { type: 'boolean' },
    },
  })
  if (values.distribution === undefined || values.out === undefined) throw new Error('--distribution and --out are required')
  const distribution = readDistribution(resolve(values.distribution))
  const runtimeVersion = values['runtime-version'] ?? distribution.dshRange.replace(/^[^\d]*/u, '')
  // A published plugin whose peer range cannot match this runtime installs nothing at
  // all, so the override is what makes the dependency set installable rather than a
  // convenience. Deriving it keeps it truthful: a fixed third party loses its entry.
  const overrides = values['skip-overrides'] === true
    ? []
    : resolvePeerOverrides(
      distribution.dependencies.map(entry => entry.name + '@' + entry.spec),
      runtimeVersion,
    )
  const manifest = {
    name: '@sparkelf/dsh-plus-standalone',
    version: distribution.version,
    private: false,
    type: 'module',
    dependencies: {
      // The official launcher carries its own peer tree, which supplies every
      // service-definition package the bundles mount.
      '@deepseek-ai/dsh': distribution.dshRange,
      ...Object.fromEntries(distribution.dependencies.map(entry => [entry.name, entry.spec])),
    },
    ...overrides.length === 0 ? {} : {
      overrides: Object.fromEntries(overrides.map(entry => [entry.name, entry.version])),
    },
    dshPlusStandalone: {
      formatVersion: 1,
      profile: 'plus',
      bundles: distribution.bundles,
      allowBuilds: distribution.allowBuilds,
      peerOverrides: overrides.map(entry => ({ name: entry.name, version: entry.version, reason: entry.reason })),
    },
  }
  writeFileSync(resolve(values.out), JSON.stringify(manifest, null, 2) + '\n')
  console.info('generate-manifest: wrote ' + resolve(values.out) + ' with ' + String(distribution.dependencies.length) + ' pinned plugin(s), ' + String(distribution.bundles.length) + ' bundle(s), and ' + String(overrides.length) + ' peer override(s).')
  for (const entry of overrides) console.info('  override ' + entry.name + '@' + entry.version + ' because ' + entry.reason)
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main()
