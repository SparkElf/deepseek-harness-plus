/**
 * Runtime paths and profile composition for a standalone Plus installation.
 *
 * A standalone consumer installs the distribution from the registry and owns its
 * profile, so this module answers the two questions every command shares: where the
 * DSH home and profile live, and what the profile manifest must contain. The bundle
 * order comes from the installed distribution rather than from a copy here, because
 * the launcher mounts exactly the bundles the profile names and nothing expands a
 * bundle's own list.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Profile name a standalone installation owns. */
export const STANDALONE_PROFILE = 'plus'

/** Resolved locations for one standalone installation. */
export interface StandalonePaths {
  /** DSH home holding profiles, credentials, and session data. */
  readonly home: string
  /** Profile directory the launcher boots. */
  readonly profileDirectory: string
  /** Installed Plus distribution directory. */
  readonly distributionDirectory: string
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object')
  return value as Record<string, unknown>
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error(label + ' must be a string array')
  return value as string[]
}

/** Resolve the DSH home, honouring the environment override the launcher itself reads. */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME
  return configured === undefined || configured === '' ? join(homedir(), '.dsh') : resolve(configured)
}

/**
 * Resolve the installed distribution directory from one requiring anchor.
 *
 * The anchor must be a path inside the consumer's own tree. Resolving from this
 * module instead would find the distribution the module itself was loaded from,
 * which is the repository during development and the consumer's install otherwise.
 *
 * @param anchor - `package.json` path or directory in the consumer tree.
 * @returns absolute path to the installed distribution.
 */
export function resolveDistributionDirectory(anchor: string): string {
  let resolved: string
  try {
    resolved = dirname(createRequire(anchor).resolve('@sparkelf/dsh-plus/package.json'))
  } catch {
    throw new Error('@sparkelf/dsh-plus is not installed in ' + dirname(anchor) + '; run this command from the directory that installed it')
  }
  // A resolution that leaves the consumer tree means the module answered from its own
  // installation, which reports health for a distribution the consumer never installed.
  const consumerRoot = resolve(dirname(anchor))
  if (!resolved.startsWith(consumerRoot + '/')) {
    throw new Error('@sparkelf/dsh-plus resolved outside ' + consumerRoot + ' (found ' + resolved + '); run this command from the directory that installed it')
  }
  return resolved
}

/** The reviewed bundle order and pins the installed distribution declares. */
export function readDistributionProfile(distributionDirectory: string): {
  readonly bundles: readonly string[]
  readonly dependencies: Readonly<Record<string, string>>
  readonly allowBuilds: Readonly<Record<string, boolean>>
  readonly version: string
} {
  const manifest = requireRecord(
    JSON.parse(readFileSync(join(distributionDirectory, 'package.json'), 'utf8')) as unknown,
    'Plus distribution manifest',
  )
  const plus = requireRecord(manifest.dshPlus, 'dshPlus')
  const profile = requireRecord(plus.profile, 'dshPlus.profile')
  const rawDependencies = requireRecord(profile.dependencies, 'dshPlus.profile.dependencies')
  const rawAllowBuilds = requireRecord(profile.allowBuilds, 'dshPlus.profile.allowBuilds')
  const dependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(rawDependencies)) {
    if (typeof spec !== 'string' || spec === '') throw new Error('dshPlus.profile.dependencies.' + name + ' must be a non-empty string')
    dependencies[name] = spec
  }
  const allowBuilds: Record<string, boolean> = {}
  for (const [name, allowed] of Object.entries(rawAllowBuilds)) {
    if (typeof allowed !== 'boolean') throw new Error('dshPlus.profile.allowBuilds.' + name + ' must be a boolean')
    allowBuilds[name] = allowed
  }
  return {
    bundles: requireStringArray(profile.bundles, 'dshPlus.profile.bundles'),
    dependencies,
    allowBuilds,
    version: String(manifest.version),
  }
}

/** Resolve every path a command needs, without creating anything. */
export function resolvePaths(anchor: string, env: NodeJS.ProcessEnv = process.env): StandalonePaths {
  const home = resolveHome(env)
  return {
    home,
    profileDirectory: join(home, 'profiles', STANDALONE_PROFILE),
    distributionDirectory: resolveDistributionDirectory(anchor),
  }
}

/**
 * Write the profile manifest when it is absent, leaving an existing one untouched.
 *
 * The distribution's own plugin dependencies are seeded here so the launcher can
 * resolve every bundle from the profile directory: a bundle the profile cannot
 * resolve fails activation with a module-resolution error, and no step in the
 * launcher expands the distribution's bundle list on its own.
 *
 * @param paths - resolved standalone paths.
 * @returns whether this call created the manifest.
 */
export function ensureProfile(paths: StandalonePaths): boolean {
  const manifestPath = join(paths.profileDirectory, 'package.json')
  if (existsSync(manifestPath)) return false
  const distribution = readDistributionProfile(paths.distributionDirectory)
  mkdirSync(paths.profileDirectory, { recursive: true })
  const manifest = {
    name: 'dsh-profile-' + STANDALONE_PROFILE,
    private: true,
    type: 'module',
    dependencies: { '@sparkelf/dsh-plus': distribution.version, ...distribution.dependencies },
    dsh: {
      profile: {
        bundles: distribution.bundles,
        patchReload: 'live',
      },
    },
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return true
}
