/**
 * Derive the profile's override table from the distribution's own facts.
 *
 * The distribution records one truth per fact: the patch set names the official packages it
 * patches, the runtime names the version its republished builds carry, and an edition names the
 * capabilities a deployment omits. The override table npm and pnpm read is a projection of those
 * three, never a fourth list: an entry that cannot be derived fails the build instead of being
 * carried forward, which is what kept a stale `@deepseek-ai/dsh-client-ui-slots` pin alive long
 * after the patch behind it had gone.
 *
 * @module manifest
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { valid, validRange } from 'semver'

/** npm scope every patched official package is republished under. */
const OFFICIAL_PREFIX = '@deepseek-ai/'
/** npm scope the distribution publishes its republished builds under. */
const REPUBLISHED_PREFIX = '@sparkelf/'

/** One entry of the distribution's patch set, as far as override derivation reads it. */
export interface PatchEntryFacts {
  readonly id: string
  readonly target: {
    readonly kind: string
    readonly packages?: readonly string[]
    readonly republish?: boolean
    readonly reason?: string
  }
}

/** Every fact the profile projection needs, validated at read time. */
export interface DistributionFacts {
  readonly name: string
  readonly version: string
  /** Exact runtime the republished builds were cut against. */
  readonly runtimeVersion: string
  /** Exact spec of the placeholder an omitted capability is substituted with. */
  readonly omissionSpec: string
  readonly bundles: readonly string[]
  readonly dependencies: Readonly<Record<string, string>>
  readonly allowBuilds: Readonly<Record<string, boolean>>
  /** Official package name to republished build spec. */
  readonly redirects: Readonly<Record<string, string>>
  /** Patch entries whose payload reaches the registry through a redirect. */
  readonly redirectIds: Readonly<Record<string, string>>
  /** Product editions: the only axis that selects a package and bundle set. */
  readonly editions: Readonly<Record<string, ProfileEdition>>
}

/** One product edition of the distribution. */
export interface ProfileEdition {
  readonly label: string
  /** Profile name the launcher materializes for this edition. */
  readonly profile: string
  /** Bundle rows the edition mounts. */
  readonly bundles: readonly string[]
  /** Package names the edition installs; versions come from `profile.dependencies`. */
  readonly packages: readonly string[]
  /** Capabilities the edition must not run, substituted with the omission placeholder. */
  readonly omit: readonly string[]
  /**
   * Packages the edition does not install or mount at all.
   *
   * Unlike `omit`, nothing is substituted: the capability is absent rather than replaced. A
   * deployment uses it to drop an optional capability the image supplies another way.
   */
  readonly excludePackages: readonly string[]
}

/** A profile projected for one edition. */
export interface ProfileProjection {
  readonly profileName: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly bundles: readonly string[]
  readonly overrides: Readonly<Record<string, string>>
  readonly allowBuilds: Readonly<Record<string, boolean>>
  readonly omittedPackages: Readonly<Record<string, string>>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object')
  return value as Record<string, unknown>
}

/** A declared value as text, or the fallback when the manifest holds something else. */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry === '')) {
    throw new Error(label + ' must be a non-empty string array')
  }
  return value as string[]
}

function stringMap(value: unknown, label: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, spec] of Object.entries(record(value, label))) {
    if (typeof spec !== 'string' || spec === '') throw new Error(label + '.' + name + ' must be a non-empty string')
    result[name] = spec
  }
  return result
}

/**
 * The republished scope name for one official package.
 *
 * @param official - an `@deepseek-ai/dsh-*` name.
 * @returns the `@sparkelf/dsh-*` name the distribution publishes it as.
 */
export function republishedName(official: string): string {
  if (!official.startsWith(OFFICIAL_PREFIX)) throw new Error(official + ' is not an official package name')
  return REPUBLISHED_PREFIX + official.slice(OFFICIAL_PREFIX.length)
}

/**
 * Derive the redirect table from the patch set.
 *
 * Every `dsh-source` entry republishes the packages its payload modifies, because a registry
 * installation has no source tree to patch. An entry that changes only types sets
 * `target.republish: false` and must say why; anything else would look like a redirect that
 * silently never happens.
 *
 * @param entries - the distribution's patch entries.
 * @param runtimeVersion - exact version the republished builds carry.
 * @returns official name to `npm:` alias spec.
 */
export function deriveRedirects(
  entries: readonly PatchEntryFacts[],
  runtimeVersion: string,
): { redirects: Record<string, string>; ids: Record<string, string> } {
  const redirects: Record<string, string> = {}
  const ids: Record<string, string> = {}
  for (const entry of entries) {
    if (entry.target.kind !== 'dsh-source') continue
    const packages = entry.target.packages ?? []
    if (packages.length === 0) throw new Error('patch entry ' + entry.id + ' declares no target packages')
    const republish = entry.target.republish !== false
    if (!republish) {
      if (entry.target.reason === undefined || entry.target.reason.trim() === '') {
        throw new Error('patch entry ' + entry.id + ' sets republish:false without a reason')
      }
      continue
    }
    for (const official of packages) {
      const spec = 'npm:' + republishedName(official) + '@' + runtimeVersion
      if (redirects[official] !== undefined && redirects[official] !== spec) {
        throw new Error('patch entries ' + (ids[official] ?? '?') + ' and ' + entry.id + ' redirect ' + official + ' to different targets')
      }
      redirects[official] = spec
      ids[official] = entry.id
    }
  }
  if (Object.keys(redirects).length === 0) throw new Error('the patch set declares no republishable target')
  return { redirects, ids }
}

/** Read and validate the facts one installed distribution declares. */
export function readDistributionFacts(directory: string): DistributionFacts {
  const manifest = record(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as unknown, 'distribution manifest')
  const plus = record(manifest.dshPlus, 'dshPlus')
  const profile = record(plus.profile, 'dshPlus.profile')
  if (profile.overrides !== undefined) {
    // The table this module replaces. Keeping both is exactly the drift that shipped a bare
    // version no patch produced, so a manifest that still carries one is rejected.
    throw new Error('dshPlus.profile.overrides is retired; overrides are derived from dshPlus.patchSet')
  }
  const runtime = record(plus.runtime, 'dshPlus.runtime')
  const runtimeVersion = text(runtime.version)
  if (valid(runtimeVersion) === null) throw new Error('dshPlus.runtime.version must be an exact version, got: ' + runtimeVersion)
  const omission = record(plus.omission, 'dshPlus.omission')
  const omissionPackage = text(omission.package)
  const omissionVersion = text(omission.version)
  if (!omissionPackage.startsWith('@sparkelf/') || valid(omissionVersion) === null) {
    throw new Error('dshPlus.omission must name an @sparkelf package and an exact version')
  }
  const compatibility = record(plus.compatibility, 'dshPlus.compatibility')
  const floor = text(compatibility.dsh)
  if (validRange(floor) === null) throw new Error('dshPlus.compatibility.dsh must be a semver range')
  const patchSet = record(plus.patchSet, 'dshPlus.patchSet')
  const rawEntries = patchSet.entries
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) throw new Error('dshPlus.patchSet.entries must be a non-empty array')
  const entries: PatchEntryFacts[] = rawEntries.map((value, index) => {
    const entry = record(value, 'patchSet.entries[' + String(index) + ']')
    const target = record(entry.target, 'patchSet.entries[' + String(index) + '].target')
    const targetFacts: PatchEntryFacts['target'] = { kind: text(target.kind) }
    if (target.packages !== undefined) {
      Object.assign(targetFacts, { packages: stringArray(target.packages, 'target.packages') })
    }
    if (target.republish === false) Object.assign(targetFacts, { republish: false })
    if (typeof target.reason === 'string') Object.assign(targetFacts, { reason: target.reason })
    return { id: text(entry.id), target: targetFacts }
  })
  const { redirects, ids } = deriveRedirects(entries, runtimeVersion)
  const dependencies = stringMap(profile.dependencies, 'dshPlus.profile.dependencies')
  const allowBuilds: Record<string, boolean> = {}
  for (const [name, allowed] of Object.entries(record(profile.allowBuilds, 'dshPlus.profile.allowBuilds'))) {
    if (typeof allowed !== 'boolean') throw new Error('dshPlus.profile.allowBuilds.' + name + ' must be a boolean')
    allowBuilds[name] = allowed
  }
  const editions: Record<string, ProfileEdition> = {}
  const rawEditions = plus.editions === undefined ? {} : record(plus.editions, 'dshPlus.editions')
  for (const [id, value] of Object.entries(rawEditions)) {
    const edition = record(value, 'dshPlus.editions.' + id)
    // Both shapes are read: an object maps names to versions (the historic form), an array names
    // them. Only the names matter now -- the version is `profile.dependencies`' job.
    const rawPackages = edition.packages
    if (rawPackages === undefined) throw new Error('dshPlus.editions.' + id + '.packages is required')
    const names = Array.isArray(rawPackages)
      ? stringArray(rawPackages, 'dshPlus.editions.' + id + '.packages')
      : Object.keys(record(rawPackages, 'dshPlus.editions.' + id + '.packages'))
    for (const name of names) {
      if (dependencyKey(dependencies, name) === undefined) {
        throw new Error('edition "' + id + '" installs ' + name + ', which dshPlus.profile.dependencies does not pin')
      }
    }
    const omit = stringArray(edition.omit ?? [], 'dshPlus.editions.' + id + '.omit')
    for (const name of omit) {
      if (dependencies[name] === undefined && (manifest.dependencies as Record<string, string> | undefined)?.[name] === undefined) {
        throw new Error('edition "' + id + '" omits ' + name + ', which the distribution does not declare')
      }
    }
    const excludePackages = stringArray(edition.excludePackages ?? [], 'dshPlus.editions.' + id + '.excludePackages')
    for (const name of excludePackages) {
      if (dependencies[name] === undefined && !stringArray(edition.bundles ?? [], 'x').includes(name)) {
        throw new Error('edition "' + id + '" excludes ' + name + ', which it does not install or mount')
      }
      if (omit.includes(name)) throw new Error('edition "' + id + '" both excludes and omits ' + name)
      // A hard dependency would keep the package in the tree through another spec, so the
      // exclusion would look applied while the install still fetched it.
      for (const [other, spec] of Object.entries(dependencies)) {
        if (/^npm:/u.test(spec) && spec.includes(name + '@')) {
          throw new Error('edition "' + id + '" excludes ' + name + ' but ' + other + ' aliases it')
        }
      }
    }
    const bundles = stringArray(edition.bundles ?? [], 'dshPlus.editions.' + id + '.bundles')
    // A bundle row whose package is substituted by the omission placeholder cannot mount: the
    // loader reads the installed manifest and finds a package that declares nothing. The two
    // lists describe one fact, so an overlap is a generation error rather than a build surprise.
    for (const name of bundles) {
      if (omit.includes(name)) throw new Error('edition "' + id + '" mounts ' + name + ' but also omits it')
    }
    editions[id] = {
      label: text(edition.label, id),
      profile: text(edition.profile, 'plus'),
      bundles,
      packages: names,
      omit,
      excludePackages,
    }
  }
  return {
    name: String(manifest.name),
    version: String(manifest.version),
    runtimeVersion,
    omissionSpec: 'npm:' + omissionPackage + '@' + omissionVersion,
    bundles: stringArray(profile.bundles, 'dshPlus.profile.bundles'),
    dependencies,
    allowBuilds,
    redirects,
    redirectIds: ids,
    editions,
  }
}

/**
 * The dependency-table key that installs one package.
 *
 * A bundle published under a scope we own is installed through an alias: the official name a
 * consumer imports (`dsh-better-sidebar`) is the key, and the spec names our build
 * (`npm:@sparkelf/dsh-better-sidebar@…`). Editions name the real package, so the
 * lookup has to follow the alias or it reports a reviewed package as unpinned.
 *
 * @param dependencies - the distribution's dependency table.
 * @param name - package name an edition names.
 * @returns the key that installs it, or undefined when the distribution does not carry it.
 */
function dependencyKey(dependencies: Readonly<Record<string, string>>, name: string): string | undefined {
  if (dependencies[name] !== undefined) return name
  for (const [key, spec] of Object.entries(dependencies)) {
    const alias = /^npm:(@[^/]+\/[^@]+)@/u.exec(spec)
    if (alias?.[1] === name) return key
  }
  return undefined
}

/**
 * Project an edition into the profile npm and pnpm install.
 *
 * The distribution's reviewed order is the base; the edition names the bundle order and package
 * set it installs and the capabilities it must not run. Versions always come from
 * `profile.dependencies`, so an edition cannot pin a version the distribution did not review.
 * No edition means the full distribution, which is what a launcher start without a selection
 * materializes.
 *
 * @param facts - validated distribution facts.
 * @param editionId - edition to project, or undefined for the full distribution.
 * @returns the profile's dependencies, bundles, and override table.
 */
export function projectEdition(facts: DistributionFacts, editionId?: string, extraExcludes: readonly string[] = []): ProfileProjection {
  const edition = editionId === undefined ? undefined : facts.editions[editionId]
  if (editionId !== undefined && edition === undefined) {
    throw new Error('unknown edition "' + editionId + '"; declared: ' + (Object.keys(facts.editions).join(', ') || '(none)'))
  }
  const excludedNames = new Set([...(edition?.excludePackages ?? []), ...extraExcludes])
  for (const name of excludedNames) {
    const declared = facts.dependencies[name] !== undefined || facts.bundles.includes(name)
    if (!declared) throw new Error('exclude names ' + name + ', which the distribution does not install or mount')
  }
  const omittedNames = new Set(edition?.omit ?? [])
  const omitted: Record<string, string> = {}
  // The placeholder is a plus-family member on its own version line, so its release identity is
  // stated once in `dshPlus.omission` rather than derived from a version that moves elsewhere.
  for (const name of omittedNames) omitted[name] = facts.omissionSpec
  const dependencies: Record<string, string> = {}
  // Official services are shared infrastructure rather than edition members: every edition
  // installs the ones the distribution reviewed, which is what keeps one version of each service
  // in the tree. An edition lists only the product packages it owns.
  const sharedOfficials = Object.keys(facts.dependencies).filter(name => name.startsWith('@deepseek-ai/dsh'))
  const packageNames = edition === undefined
    ? [...new Set([...Object.keys(facts.dependencies), ...sharedOfficials])]
    : [...new Set([...edition.packages, ...sharedOfficials])]
  for (const name of packageNames) {
    if (omittedNames.has(name) || excludedNames.has(name)) continue
    const key = dependencyKey(facts.dependencies, name) ?? name
    const spec = facts.dependencies[key]
    if (spec === undefined) throw new Error(name + ' is not a reviewed package')
    dependencies[key] = spec
  }
  // A redirect is how a registry installation receives a patched build; the profile has to
  // declare it under the official name it imports as well as override it.
  for (const [name, spec] of Object.entries(facts.redirects)) {
    if (omittedNames.has(name) || excludedNames.has(name)) continue
    dependencies[name] = spec
  }
  const bundles = (edition === undefined
    ? [...facts.bundles]
    : [...new Set(edition.bundles)]).filter(name => !excludedNames.has(name))
  // Bundle rows resolve from the profile tree, which also carries the runtime's own closure, so
  // their presence is asserted against the installed tree after the install rather than here.
  for (const name of bundles) {
    if (!facts.bundles.includes(name) && !(edition?.bundles ?? []).includes(name)) {
      throw new Error('edition "' + String(editionId) + '" mounts bundle ' + name + ', which the distribution does not declare')
    }
  }
  const overrides: Record<string, string> = {}
  for (const [name, spec] of Object.entries(facts.redirects)) {
    if (omittedNames.has(name) || excludedNames.has(name)) continue
    overrides[name] = spec
  }
  // The launcher is the runtime the republished builds were cut against. A dependency can lose
  // to hoisting when a sibling range admits a newer prerelease, and a mixed tree is what makes
  // DSH refuse rows; the override is derived from the same one fact, not a second list.
  overrides['@deepseek-ai/dsh'] = facts.runtimeVersion
  Object.assign(overrides, omitted)
  return {
    profileName: edition?.profile ?? 'plus',
    dependencies,
    bundles,
    overrides,
    allowBuilds: facts.allowBuilds,
    omittedPackages: omitted,
  }
}

/**
 * Assert every redirect target is served by a registry.
 *
 * A redirect names a published build; one that names a version the registry does not serve
 * installs nothing at all, and the failure surfaces as a resolver error that reads like a
 * packaging defect rather than a release that never happened.
 *
 * @param redirects - official name to `npm:` alias spec.
 * @param registry - npm registry base URL.
 * @returns nothing; throws on the first unavailable target.
 */
export async function assertRedirectsPublished(
  redirects: Readonly<Record<string, string>>,
  registry = 'https://registry.npmjs.org',
): Promise<void> {
  for (const spec of Object.values(redirects)) {
    const match = /^npm:(@[^/]+\/[^@]+)@(.+)$/u.exec(spec)
    if (match === null) throw new Error('redirect ' + spec + ' is not an npm alias')
    const [, name, version] = match
    if (name === undefined || version === undefined) throw new Error('redirect ' + spec + ' is not an npm alias')
    const response = await fetch(registry.replace(/\/$/u, '') + '/' + name.replace('/', '%2f') + '/' + version)
    if (!response.ok) throw new Error('redirect target ' + name + '@' + version + ' is not served by ' + registry)
  }
}

/**
 * Write the profile manifest and the pnpm workspace the install reads.
 *
 * npm reads `overrides` from the root manifest and pnpm reads them from the workspace file, so
 * both are written from the same projection. Resolver settings a container needs (store location,
 * supported architectures, release-age window) belong to the caller and are appended to the
 * workspace file afterwards.
 *
 * @param directory - profile directory to write into.
 * @param facts - validated distribution facts.
 * @param editionId - edition to project.
 * @param extraExcludes - packages the caller drops on top of the edition's own exclusions.
 * @returns the projection that was written.
 */
export function writeProfileProjection(
  directory: string,
  facts: DistributionFacts,
  editionId?: string,
  extraExcludes: readonly string[] = [],
): ProfileProjection {
  const projection = projectEdition(facts, editionId, extraExcludes)
  mkdirSync(directory, { recursive: true })
  const dependencies: Record<string, string> = {
    '@sparkelf/dsh-plus': facts.version,
    // Exact: the republished builds were cut against this runtime, and DSH refuses a row whose
    // exact peer pins disagree with the process it shares. A range admits the next prerelease and
    // reintroduces the skew the redirects exist to avoid.
    '@deepseek-ai/dsh': facts.runtimeVersion,
    ...projection.dependencies,
  }
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + projection.profileName,
    private: true,
    type: 'module',
    dependencies,
    dsh: { profile: { bundles: projection.bundles, patchReload: 'live' } },
  }, null, 2) + '\n')
  const workspace = [
    'packages:',
    '  - .',
    'nodeLinker: hoisted',
    // Official peers come from the exact runtime this profile declares. Installing them from
    // their own ranges lets a newer prerelease in beside the republished builds, and DSH then
    // disables every row whose exact peers disagree with the runtime it boots.
    'autoInstallPeers: false',
    '',
    'overrides:',
    ...Object.keys(projection.overrides).sort().map(name => '  ' + JSON.stringify(name) + ': ' + (projection.overrides[name] ?? '')),
    '',
    'allowBuilds:',
    ...Object.keys(projection.allowBuilds).sort().map(name => '  ' + JSON.stringify(name) + ': ' + String(projection.allowBuilds[name])),
    '',
  ]
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), workspace.join('\n'))
  return projection
}

/** Whether a path is a directory carrying a package manifest. */
export function isDistributionDirectory(directory: string): boolean {
  return existsSync(join(resolve(directory), 'package.json'))
}
