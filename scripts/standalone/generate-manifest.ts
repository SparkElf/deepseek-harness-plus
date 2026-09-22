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
 * A deployment that must not carry every reviewed plugin selects a variant declared under
 * `dshPlus.profile.standaloneVariants`. A variant names its own package and profile and
 * lists the packages and bundles it omits, so an intranet image can install from the
 * registry without the capabilities it is not allowed to run. The default manifest is the
 * unreduced distribution, which is what a public consumer receives.
 *
 * Usage: tsx scripts/standalone/generate-manifest.ts --distribution <dir> --out <file> [--variant <id>]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolvePeerOverrides } from './peer-overrides.ts'

/** Published name of the placeholder an omitted capability is overridden onto. */
export const OMITTED_PLACEHOLDER_PACKAGE = '@sparkelf/dsh-omitted'

/**
 * Override spec that substitutes the placeholder for one omitted capability.
 *
 * The placeholder is a plus-family member, so it carries the distribution's own version:
 * deriving it keeps a version bump from leaving the override pinned to a release the
 * registry no longer serves beside the manifest that names it.
 *
 * @param version - the distribution's version.
 * @returns the npm alias spec to write into the override.
 */
export function omittedPlaceholderSpec(version: string): string {
  return 'npm:' + OMITTED_PLACEHOLDER_PACKAGE + '@' + version
}

/** One registry-installable variant of the distribution. */
interface StandaloneVariant {
  /** Published package name this variant builds. */
  readonly packageName: string
  /** Profile name the launcher materializes. */
  readonly profile: string
  /** Reviewed packages this variant must not install. */
  readonly excludePackages: readonly string[]
  /** Bundles this variant must not mount. */
  readonly excludeBundles: readonly string[]
}

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
  readonly variants: Readonly<Record<string, StandaloneVariant>>
  readonly allowBuilds: Readonly<Record<string, boolean>>
  readonly overrides: Readonly<Record<string, string>>
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
  // An optional dependency is a capability the distribution can run but does not require:
  // it must stay installable for a deployment that keeps it, and it must be nameable by a
  // variant that omits it, so it joins the reviewed set rather than being dropped.
  const optionalDependencies = manifest.optionalDependencies === undefined
    ? []
    : Object.entries(requireRecord(manifest.optionalDependencies, 'distribution optionalDependencies'))
      .map(([name, spec]) => ({ name, spec: String(spec) }))
  const merged = new Map<string, ProfileDependency>()
  for (const entry of [...dependencies, ...runtimeDependencies, ...optionalDependencies]) merged.set(entry.name, entry)
  // A patch against official source cannot reach a registry installation, so the
  // distribution republishes the affected workspaces and declares the substitution
  // here. The manifest has to carry it: npm resolves the tree during \`npm install\`,
  // which happens before any command of ours runs.
  const overrides: Record<string, string> = {}
  const rawOverrides = profile.overrides === undefined
    ? {}
    : requireRecord(profile.overrides, 'dshPlus.profile.overrides')
  for (const [name, spec] of Object.entries(rawOverrides)) {
    if (typeof spec !== 'string' || spec === '') throw new Error('dshPlus.profile.overrides.' + name + ' must be a non-empty string')
    overrides[name] = spec
  }
  // A variant is a named reduction of the same reviewed facts: it installs fewer packages
  // and mounts fewer bundles, so an intranet deployment never receives a capability it is
  // not allowed to run. Absent variants leave the manifest identical to today's.
  const rawVariants = profile.standaloneVariants === undefined
    ? {}
    : requireRecord(profile.standaloneVariants, 'dshPlus.profile.standaloneVariants')
  const variants: Record<string, StandaloneVariant> = {}
  for (const [id, raw] of Object.entries(rawVariants)) {
    const variant = requireRecord(raw, 'dshPlus.profile.standaloneVariants.' + id)
    variants[id] = {
      packageName: String(variant.packageName),
      profile: String(variant.profile),
      excludePackages: requireStringArray(variant.excludePackages, 'standaloneVariants.' + id + '.excludePackages'),
      excludeBundles: requireStringArray(variant.excludeBundles, 'standaloneVariants.' + id + '.excludeBundles'),
    }
  }
  return {
    name: String(manifest.name),
    version: String(manifest.version),
    dshRange: String(compatibility.dsh),
    bundles: requireStringArray(profile.bundles, 'dshPlus.profile.bundles'),
    dependencies: [...merged.values()],
    allowBuilds,
    overrides,
    variants,
  }
}

function main(): void {
  const { values } = parseArgs({
    options: {
      distribution: { type: 'string' },
      out: { type: 'string' },
      'runtime-version': { type: 'string' },
      'skip-overrides': { type: 'boolean' },
      variant: { type: 'string' },
      check: { type: 'boolean' },
    },
  })
  if (values.distribution === undefined || values.out === undefined) throw new Error('--distribution and --out are required')
  const distribution = readDistribution(resolve(values.distribution))
  // A named variant installs and mounts strictly less than the distribution. Selecting one
  // is the only way the reduction reaches a manifest, so an unselected build stays whole.
  const variantId = values.variant
  const variant = variantId === undefined ? undefined : distribution.variants[variantId]
  if (variantId !== undefined && variant === undefined) {
    throw new Error('generate-manifest: unknown variant "' + variantId + '"; declared: '
      + (Object.keys(distribution.variants).join(', ') || '(none)'))
  }
  const excludedPackages = new Set(variant?.excludePackages ?? [])
  const excludedBundles = new Set(variant?.excludeBundles ?? [])
  for (const name of excludedPackages) {
    if (!distribution.dependencies.some(entry => entry.name === name)) {
      throw new Error('generate-manifest: variant "' + String(variantId) + '" excludes ' + name + ', which the distribution does not declare')
    }
  }
  for (const name of excludedBundles) {
    if (!distribution.bundles.includes(name)) {
      throw new Error('generate-manifest: variant "' + String(variantId) + '" excludes bundle ' + name + ', which the distribution does not mount')
    }
  }
  const bundles = distribution.bundles.filter(entry => !excludedBundles.has(entry))
  const dependencies = distribution.dependencies.filter(entry => !excludedPackages.has(entry.name))
  const runtimeVersion = values['runtime-version'] ?? distribution.dshRange.replace(/^[^\d]*/u, '')
  // A published plugin whose peer range cannot match this runtime installs nothing at
  // all, so the override is what makes the dependency set installable rather than a
  // convenience. Deriving it keeps it truthful: a fixed third party loses its entry.
  const overrides = values['skip-overrides'] === true
    ? []
    : resolvePeerOverrides(
      dependencies.map(entry => entry.name + '@' + entry.spec),
      runtimeVersion,
      'https://registry.npmjs.org',
      Object.fromEntries(dependencies.map(entry => [entry.name, entry.spec])),
    )
  // An override cannot name a package the manifest also lists as a direct dependency:
  // npm rejects that combination as EOVERRIDE. The tree root therefore travels as a
  // dependency alias, and the remaining substitutions as overrides onto its transitive
  // dependencies. Both keep the official name, which is what the built code imports.
  const rootAliases = Object.fromEntries(
    Object.entries(distribution.overrides).filter(([name]) => dependencies.some(entry => entry.name === name)),
  )
  const transitiveOverrides = Object.fromEntries(
    Object.entries(distribution.overrides).filter(([name]) => rootAliases[name] === undefined),
  )
  const manifest = {
    name: variant?.packageName ?? '@sparkelf/dsh-plus-standalone',
    version: distribution.version,
    private: false,
    type: 'module',
    dependencies: {
      // The official launcher carries its own peer tree, which supplies every
      // service-definition package the bundles mount. It resolves inside the workspace,
      // so the repository convention for a workspace member is the workspace protocol
      // over the minimum range.
      '@deepseek-ai/dsh': 'workspace:' + distribution.dshRange,
      // The distribution is itself a mounted bundle and carries the launcher command.
      // It appears in the bundle order but in none of the dependency lists it declares,
      // so an installation that omits it mounts nothing and has no command to run.
      [distribution.name]: 'workspace:' + distribution.version,
      ...Object.fromEntries(dependencies.map(entry => [entry.name, entry.spec])),
      ...rootAliases,
    },
    overrides: {
      ...Object.fromEntries(overrides.map(entry => [entry.name, entry.version])),
      ...transitiveOverrides,
    },
    dshPlusStandalone: {
      formatVersion: 1,
      // The installing package declares the profile it materializes, so the launcher can
      // resolve a variant's own profile name from this manifest at start time.
      profile: variant?.profile ?? 'plus',
      bundles,
      allowBuilds: distribution.allowBuilds,
      peerOverrides: overrides.map(entry => ({ name: entry.name, version: entry.version, reason: entry.reason })),
      // npm has no removal semantics, so an omitted capability is substituted rather than
      // deleted. Recording the substitution here is what lets a deployment assert the
      // omission without restating the list it was generated from.
      omittedPackages: Object.fromEntries(
        [...excludedPackages].map(name => [name, omittedPlaceholderSpec(distribution.version)]),
      ),
    },
  }
  const out = resolve(values.out)
  // An existing manifest already owns its identity fields; regenerating rewrites only the
  // facts this generator derives, so a hand-edited description or license survives.
  const previous = existsSync(out)
    ? JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>
    : {}
  // Compare only the fields this generator owns: the manifest also carries identity and
  // packaging fields a maintainer sets, and those must not read as drift.
  const owned = Object.keys(manifest)
  if (values.check === true) {
    // Reachability is what the check protects: a plugin the distribution reviews but the
    // manifest omits is a bundle the profile cannot resolve, and npm installs the set
    // without complaint either way.
    if (!existsSync(out)) throw new Error('generate-manifest: ' + out + ' does not exist; run the generator')
    const stale = owned.filter(key => JSON.stringify(previous[key]) !== JSON.stringify(manifest[key as keyof typeof manifest]))
    if (stale.length > 0) {
      throw new Error('generate-manifest: ' + out + ' is stale in ' + stale.join(', ') + '; run the generator and commit the result')
    }
    console.info('generate-manifest: ' + out + ' matches the distribution.')
    return
  }
  writeFileSync(out, JSON.stringify({ ...previous, ...manifest }, null, 2) + '\n')
  console.info('generate-manifest: wrote ' + out + ' with ' + String(dependencies.length) + ' pinned plugin(s), ' + String(bundles.length) + ' bundle(s), and ' + String(overrides.length) + ' peer override(s).'
    + (variant === undefined ? '' : ' (variant ' + String(variantId) + ' excluded ' + String(excludedPackages.size) + ' package(s) and ' + String(excludedBundles.size) + ' bundle(s))'))
  for (const entry of overrides) console.info('  override ' + entry.name + '@' + entry.version + ' because ' + entry.reason)
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main()
