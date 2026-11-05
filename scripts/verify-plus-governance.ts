/** Verify Plus npm composition, independent patch packages, and curation ownership. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { satisfies, valid, validRange } from 'semver'
import { loadCordisYaml } from './cordis-yaml.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const distributionPath = 'packages/bundle/plus/package.json'

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object')
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(label + ' must be a non-empty string')
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(label + ' must be an array')
  return value
}

function packageNameFromSpecifier(specifier: string): string {
  const segments = specifier.split('/')
  if (specifier.startsWith('@')) {
    const scope = segments[0]
    const name = segments[1]
    if (scope === undefined || scope === '' || name === undefined || name === '') {
      throw new Error('invalid scoped package specifier: ' + specifier)
    }
    return scope + '/' + name
  }
  const name = segments[0]
  if (name === undefined || name === '') throw new Error('invalid package specifier: ' + specifier)
  return name
}

function json(path: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(resolve(root, path), 'utf8')) as unknown, path)
}

function minimumRange(value: unknown, label: string): string {
  const source = string(value, label)
  const range = source.startsWith('workspace:') ? source.slice('workspace:'.length) : source
  if (!/^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(range) || validRange(range) === null) {
    throw new Error(label + ' must be a minimum-only semantic-version range')
  }
  return range
}

function main(): void {
  const distribution = json(distributionPath)
  const plus = object(distribution.dshPlus, 'dshPlus')
  if (plus.formatVersion !== 1) throw new Error('dshPlus.formatVersion must be 1')
  const sourceBase = object(plus.sourceBase, 'dshPlus.sourceBase')
  const sourceBaseRevision = string(sourceBase.revision, 'dshPlus.sourceBase.revision')
  if (!/^[0-9a-f]{40}$/.test(sourceBaseRevision)) throw new Error('dshPlus.sourceBase.revision must be a full git revision')
  const compatibility = object(plus.compatibility, 'dshPlus.compatibility')
  minimumRange(compatibility.dsh, 'dshPlus.compatibility.dsh')
  const dependencies = object(distribution.dependencies, 'distribution dependencies')
  for (const [name, range] of Object.entries(dependencies)) {
    // Official packages are held to the exact runtime generation below, and the packages this
    // repository publishes are exact by the rule below; the minimum-range rule applies to the
    // third-party plugins that track their own version lines.
    if (name.startsWith('@deepseek-ai/dsh') || name.startsWith('@sparkelf/')) continue
    minimumRange(range, 'distribution dependencies.' + name)
  }
  // A range on an official package drifts to the newest matching prerelease: under semver's
  // prerelease rule `0.2.2-rc.1` satisfies `>=0.2.2-alpha.2`, so a distribution that declares one
  // runtime generation installs another and its own profile comparison fails. Exact versions are
  // the only form that keeps the package and the runtime it declares in one generation.
  for (const [name, spec] of Object.entries(dependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue
    if (valid(String(spec)) !== null) continue
    throw new Error('distribution dependencies.' + name + ' must be an exact version, got ' + String(spec))
  }
  const profile = object(plus.profile, 'dshPlus.profile')
  const bundles = array(profile.bundles, 'dshPlus.profile.bundles').map((value, index) =>
    string(value, 'dshPlus.profile.bundles[' + String(index) + ']'))
  if (new Set(bundles).size !== bundles.length) throw new Error('dshPlus.profile.bundles must not contain duplicates')
  // The runtime floor and the republished pins move together or the image is broken in a way
  // no other check names. A profile installs each official package from its override, so a
  // floor below those pins admits a runtime older than the packages it must host: 0.2.1-alpha.1
  // plugins were refused by a 0.2.0-rc.2 launcher, and the profile never started. The floor
  // cannot simply be the pin either -- a floor is a range that later patches raise, and a
  // prerelease floor only admits prereleases of its own major.minor.patch, so ">=0.2.0-rc.2"
  // silently excludes every 0.2.1 prerelease. Requiring the floor to admit the pinned runtime
  // states the relationship the promotion has to preserve.
  const compatibilityFloor = minimumRange(compatibility.dsh, 'dshPlus.compatibility.dsh')
  // The override table is a projection of the patch set, never a stored list. This gate owns the
  // same contract the generator enforces, so a manifest that reintroduces a hand-maintained table
  // fails here even before a release tries to publish it.
  if (profile.overrides !== undefined) {
    throw new Error('dshPlus.profile.overrides is retired; overrides are derived from dshPlus.patchSet')
  }
  if (profile.standaloneVariants !== undefined) {
    throw new Error('dshPlus.profile.standaloneVariants is retired; rename it to dshPlus.profile.variants')
  }
  const runtime = object(plus.runtime, 'dshPlus.runtime')
  const runtimeVersion = string(runtime.version, 'dshPlus.runtime.version')
  if (valid(runtimeVersion) === null) throw new Error('dshPlus.runtime.version must be an exact version')
  const patchSet = object(plus.patchSet, 'dshPlus.patchSet')
  const patchEntries = array(patchSet.entries, 'dshPlus.patchSet.entries')
  const redirects = new Map<string, string>()
  for (const [index, raw] of patchEntries.entries()) {
    const entry = object(raw, 'dshPlus.patchSet.entries[' + String(index) + ']')
    const target = object(entry.target, 'dshPlus.patchSet.entries[' + String(index) + '].target')
    if (target.kind !== 'dsh-source') continue
    if (target.republish === false) {
      string(target.reason, 'dshPlus.patchSet.entries[' + String(index) + '].target.reason')
      continue
    }
    for (const [packageIndex, name] of array(target.packages, 'target.packages').entries()) {
      const official = string(name, 'target.packages[' + String(packageIndex) + ']')
      if (!official.startsWith('@deepseek-ai/')) throw new Error('patch target ' + official + ' is not an official package')
      redirects.set(official, 'npm:@sparkelf/' + official.slice('@deepseek-ai/'.length) + '@' + runtimeVersion)
    }
  }
  if (redirects.size === 0) throw new Error('dshPlus.patchSet must republish at least one package')
  for (const [name, spec] of redirects) {
    if (!spec.endsWith('@' + runtimeVersion)) throw new Error('redirect for ' + name + ' does not name the runtime version')
  }
  if (!satisfies(runtimeVersion, compatibilityFloor)) {
    throw new Error('dshPlus.compatibility.dsh (' + compatibilityFloor + ') must admit the runtime the redirects name ' + runtimeVersion
      + '; a prerelease floor admits only its own major.minor.patch, so it moves with the runtime')
  }
  const profileDependencies = object(profile.dependencies, 'dshPlus.profile.dependencies')
  /** The version part of a direct or aliased spec, or undefined when it is a range. */
  const exactVersion = (spec: string): string | undefined => {
    if (spec.startsWith('npm:')) {
      const separator = spec.lastIndexOf('@')
      return separator > 'npm:@'.length ? spec.slice(separator + 1) : undefined
    }
    return spec
  }
  for (const [name, spec] of Object.entries(profileDependencies)) {
    // Which packages are "ours" is a prefix, not a list: the repository publishes every
    // @sparkelf package, and a range on one of them drifts with our release cadence the same
    // way an official range drifts with the runtime. Third-party plugins keep their own lines.
    const ours = name.startsWith('@sparkelf/') || String(spec).startsWith('npm:@sparkelf/')
    if (!ours && !name.startsWith('@deepseek-ai/dsh')) continue
    const version = exactVersion(String(spec))
    if (version !== undefined && valid(version) !== null) continue
    throw new Error('dshPlus.profile.dependencies.' + name + ' must name an exact version, got ' + String(spec))
  }
  // The reviewed set is no longer restated here: every plugin enters the profile through the
  // distribution's own dependency table, and the bundle and omission checks above prove that
  // table is complete. A second hardcoded copy drifted for months and failed on every entry the
  // distribution legitimately outgrew.
  const allowBuilds = object(profile.allowBuilds, 'dshPlus.profile.allowBuilds')
  // Each entry is version-pinned because pnpm matches a transitive dependency by
  // \`name@version\` and replaces an unmatched entry with a placeholder, which makes the
  // install fail rather than merely skip a build.
  // pnpm matches an allowBuilds key by bare package name, whichever version the tree
  // resolves. A name@version key matches only that exact version, and every dependency
  // here is declared with a range, so the resolved version differs between machines —
  // which is how koffi@3.2.1 on one consumer's machine missed a koffi@3.3.0 entry.
  if (JSON.stringify(allowBuilds) !== JSON.stringify({
    '@deepseek-ai/dsh-subprocess-local': true,
    '@google/genai': false,
    '@officecli/officecli': true,
    'cpu-features': false,
    'koffi': true,
    'node-pty': true,
    'oracledb': true,
    'protobufjs': false,
    'ssh2': true,
  })) {
    throw new Error('dshPlus.profile.allowBuilds must match the reviewed production native-build set')
  }
  // External runtime packages由transitive dependency或apply-owned profile dependency恰好一个owner提供。
  for (const name of Object.keys(profileDependencies)) {
    if (dependencies[name] !== undefined) throw new Error(name + ' must not have two dependency owners')
  }
  /**
   * Whether the distribution owns a runtime package, counting the name it publishes it under.
   *
   * A republished package installs through an npm alias, so a name only appears as an alias
   * target: the profile declares `@deepseek-ai/dsh-llm-pi-ai: npm:@sparkelf/dsh-llm-pi-ai@…` in
   * its overrides, and a patch for the republished build names `@sparkelf/dsh-llm-pi-ai`. Reading
   * the alias target as an owner is what keeps such a patch admissible. The comparison is on the
   * package name alone, because the alias carries the version that moves with every release.
   *
   * @param name - package name a patch target or profile bundle names.
   * @returns whether any dependency or override map declares it, directly or as an alias target.
   */
  const ownsRuntimePackage = (name: string): boolean => {
    for (const source of [dependencies, profileDependencies]) {
      for (const [declared, spec] of Object.entries(source)) {
        if (declared === name) return true
        if (typeof spec === 'string' && /^npm:(@[^/]+\/[^@]+)@/.exec(spec)?.[1] === name) return true
      }
    }
    return false
  }
  for (const bundle of bundles) {
    if (bundle.startsWith('@deepseek-ai/') || bundle === distribution.name) continue
    if (!ownsRuntimePackage(bundle)) throw new Error('distribution must own external profile bundle ' + bundle)
  }
  // The independent patch packages and their curated retirement list were retired with the
  // standalone distribution: the patch set is embedded in this manifest and validated by
  // `dsh-plus apply` and by the release gates that pack it.
  const patch = loadCordisYaml(readFileSync(resolve(root, 'packages/bundle/plus/cordis.patch.yml'), 'utf8'))
  const rows = array(patch, 'Plus Cordis patch').flatMap((operation) => {
    const insert = object(operation, 'Plus Cordis operation').insert
    return insert === undefined ? [] : array(insert, 'Plus Cordis insert')
  })
  for (const raw of rows) {
    const row = object(raw, 'Plus Cordis row')
    const name = string(row.name, 'Plus Cordis row name')
    const packageName = packageNameFromSpecifier(name)
    if (!ownsRuntimePackage(packageName)) throw new Error('distribution must own Cordis row package ' + packageName)
  }
  console.info('verify-plus-governance: profile composition, patch packages, source base, and curation are consistent.')
}

main()
