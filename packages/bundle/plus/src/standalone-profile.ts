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

import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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
  readonly name: string
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
    name: String(manifest.name),
    bundles: requireStringArray(profile.bundles, 'dshPlus.profile.bundles'),
    dependencies,
    allowBuilds,
    version: String(manifest.version),
  }
}

/**
 * Point the profile at the consumer's installed packages.
 *
 * The launcher resolves a bundle from the profile directory, so a profile with no
 * `node_modules` cannot see packages the consumer installed beside it. One link to
 * the consumer's directory keeps a single installed copy as the only authority.
 *
 * npm hoists what it can and nests the rest, so a bundle can sit at the consumer's
 * top level or inside the package that depends on it. The profile reaches the first
 * through one link and the second through the distribution's own `node_modules`, and
 * a bundle found in neither is one the installation does not carry at all.
 *
 * @param paths - resolved standalone paths.
 * @param consumerDirectory - directory whose `node_modules` holds the packages.
 */
export function linkConsumerPackages(paths: StandalonePaths, consumerDirectory: string): void {
  const target = join(consumerDirectory, 'node_modules')
  if (!existsSync(target)) {
    throw new Error('no node_modules in ' + consumerDirectory + '; run npm install there first')
  }
  mkdirSync(paths.profileDirectory, { recursive: true })
  const link = join(paths.profileDirectory, 'node_modules')
  if (!existsSync(link)) symlinkSync(target, link, 'junction')
  // A profile created before the installation changed must still reach what npm nested
  // afterwards, so this runs on every start rather than only when the profile is new.
  linkNestedBundles(paths, target)
}

/**
 * Expose the distribution's nested packages at the top level the profile searches.
 *
 * The profile resolves a bundle from one directory, so a package npm nested under the
 * distribution is invisible there even though the installation carries it. Linking each
 * one beside the hoisted packages keeps a single installed copy and needs no reinstall.
 *
 * @param paths - resolved standalone paths.
 * @param consumerModules - the consumer's `node_modules` directory.
 */
function linkNestedBundles(paths: StandalonePaths, consumerModules: string): void {
  const nested = join(paths.distributionDirectory, 'node_modules')
  if (!existsSync(nested)) return
  for (const entry of readdirSync(nested)) {
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(join(nested, entry))) {
        linkBundle(consumerModules, join(entry, scoped), join(nested, entry, scoped))
      }
      continue
    }
    linkBundle(consumerModules, entry, join(nested, entry))
  }
}

/** Link one nested bundle into the consumer's top level when it is not already there. */
function linkBundle(consumerModules: string, name: string, source: string): void {
  const destination = join(consumerModules, name)
  if (existsSync(destination)) return
  try {
    symlinkSync(source, destination, 'junction')
  } catch {
    // A concurrent start may have created the same link; the existing one is equivalent.
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
 * The profile also links the consumer's installed packages, because the launcher
 * resolves each bundle from the profile directory rather than from the directory
 * that installed them.
 *
 * @param paths - resolved standalone paths.
 * @param consumerDirectory - directory whose `node_modules` holds the installed packages.
 * @returns whether this call created the manifest.
 */
export function ensureProfile(paths: StandalonePaths, consumerDirectory: string): boolean {
  linkConsumerPackages(paths, consumerDirectory)
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
