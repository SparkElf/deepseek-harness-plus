/**
 * The durable DataOps plugin set a workspace image must carry.
 *
 * The profile is assembled from two sources: plugins the distribution variant declares
 * (`dshPlus.profile.standaloneVariants.dataops` → the generated standalone manifest) and
 * private plugins handed in as `--extra-plugins` tarballs. Both used to fail silently when a
 * base upgrade changed one source: the image built, the profile booted, and the capability was
 * simply absent. This module is the single list both the assembler and the image verifier check,
 * so a build that loses one fails instead of shipping.
 *
 * `registry` names published packages the variant installs and mounts. `extraPlugins` names
 * private packages that cannot be resolved from npm: each must arrive as a tarball at the
 * declared version and mount a bundle row.
 *
 * @module dataops-required-plugins
 */
import { readFileSync } from 'node:fs'

/**
 * Read and validate the required-plugin declaration.
 * @param {string} path - the JSON file beside the assembler and the image verifier.
 * @returns {{ registry: string[], extraPlugins: Array<{ name: string, version: string, source?: string }> }}
 */
export function readRequiredPlugins(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  const registry = value?.registry
  const extraPlugins = value?.extraPlugins
  if (!Array.isArray(registry) || registry.some(entry => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error('required plugins: "registry" must be a list of package names')
  }
  if (!Array.isArray(extraPlugins)) {
    throw new Error('required plugins: "extraPlugins" must be a list')
  }
  for (const entry of extraPlugins) {
    if (typeof entry?.name !== 'string' || entry.name.length === 0) {
      throw new Error('required plugins: every extraPlugins entry needs a name')
    }
    if (typeof entry?.version !== 'string' || entry.version.length === 0) {
      throw new Error('required plugins: ' + entry.name + ' needs an exact version')
    }
  }
  const aliases = value?.aliases ?? {}
  if (typeof aliases !== 'object' || Array.isArray(aliases)) throw new Error('required plugins: "aliases" must be an object')
  for (const [name, list] of Object.entries(aliases)) {
    if (typeof name !== 'string' || !Array.isArray(list) || list.some(entry => typeof entry !== 'string')) {
      throw new Error('required plugins: alias entries must be string arrays')
    }
  }
  return { registry, extraPlugins, aliases }
}

/**
 * Compare the assembled profile with the declaration and describe every unmet requirement.
 *
 * A name can be present yet wrong in three ways, and each has produced a broken workspace
 * before: installed without a bundle row (silent, mounts nothing), declared without an installed
 * package (boot failure), and installed at a version other than the reviewed one. The check
 * therefore reads the assembled manifest's dependencies and bundles plus the tarball versions
 * the extra-plugins scan actually installed.
 *
 * @param {object} profile - the assembled profile facts.
 * @param {string[]} profile.bundles - bundle rows the profile declares.
 * @param {Record<string, string>} profile.dependencies - dependency spec per package name.
 * @param {Map<string, string> | Record<string, string>} profile.extraVersions - version installed per extra package.
 * @param {{ registry: string[], extraPlugins: Array<{ name: string, version: string }> }} required - the declaration.
 * @returns {string[]} one line per unmet requirement, empty when the profile is complete.
 */
export function missingRequiredPlugins(profile, required) {
  const problems = []
  const dependsOn = name => Object.hasOwn(profile.dependencies ?? {}, name)
  const bundled = new Set(profile.bundles ?? [])
  const extraVersions = profile.extraVersions instanceof Map
    ? profile.extraVersions
    : new Map(Object.entries(profile.extraVersions ?? {}))
  const aliases = required.aliases ?? {}
  const candidates = name => [name, ...(aliases[name] ?? [])]
  for (const name of required.registry) {
    const names = candidates(name)
    if (!names.some(dependsOn)) problems.push(name + ' is not declared in the profile dependencies')
    if (!names.some(entry => bundled.has(entry))) problems.push(name + ' holds no dsh.profile.bundles row')
  }
  for (const entry of required.extraPlugins) {
    const installed = extraVersions.get(entry.name)
    if (installed === undefined) {
      problems.push(entry.name + '@' + entry.version + ' was not installed from --extra-plugins')
    } else if (installed !== entry.version) {
      problems.push(entry.name + ' installed at ' + installed + ' but the deployment requires ' + entry.version)
    }
    if (!dependsOn(entry.name)) problems.push(entry.name + ' is not declared in the profile dependencies')
    if (!bundled.has(entry.name)) problems.push(entry.name + ' holds no dsh.profile.bundles row')
  }
  return problems
}

/**
 * Throw one build-stopping error that lists every unmet requirement.
 * @param {object} profile - see {@link missingRequiredPlugins}.
 * @param {{ registry: string[], extraPlugins: Array<{ name: string, version: string }> }} required - the declaration.
 * @param {string} [origin] - caller name used in the message, e.g. `assemble-registry-profile`.
 */
export function assertRequiredPlugins(profile, required, origin = 'profile') {
  const problems = missingRequiredPlugins(profile, required)
  if (problems.length === 0) return
  throw new Error(origin + ': the DataOps profile is missing required plugins:\n  - ' + problems.join('\n  - '))
}
