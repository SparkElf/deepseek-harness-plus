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

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { parseDocument } from 'yaml'

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
 * Whether one absolute path is the other or sits beneath it.
 *
 * A path outside the parent has a relative form starting with `..`, which every
 * platform answers the same way. Comparing the text against a literal separator is
 * not: Windows separates with a backslash, so a nested path never matched its own
 * ancestor and every Windows installation reported the distribution as sitting
 * outside its own tree.
 *
 * @param candidate - absolute path to test.
 * @param parent - absolute path that may contain it.
 * @param platform - separating convention, injectable so the Windows answer is
 * testable where the suite runs on a POSIX host.
 * @returns true when the candidate is the parent or inside it.
 */
export function isWithin(candidate: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  if (candidate === parent) return true
  const path = platform === 'win32' ? win32 : posix
  const inside = path.relative(parent, candidate)
  return inside !== '' && !inside.startsWith('..') && !inside.startsWith(path.sep + '..')
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
  // The comparison walks up from the anchor because the resolved package sits under the
  // anchor's \`node_modules\`, not beside it: requiring \`<root>/package.json\` legitimately
  // reports \`<root>/node_modules/@sparkelf/dsh-plus\`.
  let current = resolve(dirname(anchor))
  for (;;) {
    if (isWithin(resolved, current)) return resolved
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error('@sparkelf/dsh-plus resolved outside ' + resolve(dirname(anchor)) + ' (found ' + resolved + '); run this command from the directory that installed it')
}

/** The reviewed bundle order and pins the installed distribution declares. */
export function readDistributionProfile(distributionDirectory: string): {
  readonly name: string
  readonly bundles: readonly string[]
  readonly dependencies: Readonly<Record<string, string>>
  readonly allowBuilds: Readonly<Record<string, boolean>>
  readonly overrides: Readonly<Record<string, string>>
  readonly dshRange: string
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
  // An override substitutes our republished build for an official package by name: the
  // built code imports the official specifier, so the installed location has to keep
  // that name while its contents come from ours.
  const overrides: Record<string, string> = {}
  const rawOverrides = profile.overrides === undefined
    ? {}
    : requireRecord(profile.overrides, 'dshPlus.profile.overrides')
  for (const [name, spec] of Object.entries(rawOverrides)) {
    if (typeof spec !== 'string' || spec === '') throw new Error('dshPlus.profile.overrides.' + name + ' must be a non-empty string')
    overrides[name] = spec
  }
  const compatibility = requireRecord(plus.compatibility, 'dshPlus.compatibility')
  return {
    name: String(manifest.name),
    bundles: requireStringArray(profile.bundles, 'dshPlus.profile.bundles'),
    dependencies,
    allowBuilds,
    overrides,
    dshRange: String(compatibility.dsh),
    version: String(manifest.version),
  }
}

/**
 * Give the profile its own installed tree, built from the distribution's declarations.
 *
 * The launcher resolves a bundle from the profile directory, so the profile needs its
 * own `node_modules`. Pointing it at the consumer's tree was cheaper, but it made the
 * profile inherit whatever npm had already installed — including the official packages
 * the distribution's `overrides` exist to replace. npm applies `overrides` only from a
 * project's own root, so a profile without its own tree cannot receive them at all, and
 * a patch delivered that way silently never arrives.
 *
 * Installing here makes the profile that root: pnpm reads `overrides` from the
 * profile's own `pnpm-workspace.yaml`, which `writeProfileOverrides` writes before this
 * runs. The install is skipped once the tree exists so a start does not pay for it
 * twice; `dsh-plus apply` remains the command that reinstalls after a change.
 *
 * @param paths - resolved standalone paths.
 * @param consumerDirectory - directory whose `node_modules` holds the installation.
 */
export function installProfilePackages(paths: StandalonePaths, consumerDirectory: string): void {
  const consumerModules = join(consumerDirectory, 'node_modules')
  if (!existsSync(consumerModules)) {
    throw new Error('no node_modules in ' + consumerDirectory + '; run npm install there first')
  }
  const profileModules = join(paths.profileDirectory, 'node_modules')
  if (existsSync(profileModules)) {
    // A profile installed before the distribution declared overrides still needs the
    // packages it reaches from the consumer tree, which npm nested rather than hoisted.
    linkNestedBundles(paths, profileModules)
    return
  }
  runPnpm(paths.profileDirectory, ['install', '--no-frozen-lockfile'], 'pnpm install in the plus profile')
  alignReplacedPackageNames(profileModules)
  linkNestedBundles(paths, profileModules)
}

/**
 * Make each replaced package declare the name of the location it occupies.
 *
 * \`overrides\` installs our build at the official path, but the manifest inside still
 * names our scope. The client module system resolves a loader entry's declared name and
 * then requires the manifest it finds to declare that same name
 * (\`client/modules\`: \`name === expectedPackageName\`); a mismatch makes the package own no
 * browser module at all. The symptom is silent — the packages install, the server starts,
 * and the panels those packages render simply never appear.
 *
 * The rewrite replaces the file rather than writing through it: pnpm hard-links a package
 * manifest into its content-addressed store, so an in-place write would edit every
 * profile sharing that store entry.
 *
 * @param profileModules - the profile's \`node_modules\` directory.
 */
export function alignReplacedPackageNames(profileModules: string): void {
  const scoped = join(profileModules, '@deepseek-ai')
  if (!existsSync(scoped)) return
  for (const entry of readdirSync(scoped)) {
    const manifestPath = join(scoped, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    const declared = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const expected = '@deepseek-ai/' + entry
    if (declared.name === expected) continue
    const replaced = { ...declared, name: expected }
    const temporary = manifestPath + '.dsh-name'
    writeFileSync(temporary, JSON.stringify(replaced, null, 2) + '\n')
    renameSync(temporary, manifestPath)
  }
}

/**
 * Run pnpm in one directory, inheriting its output.
 *
 * Windows resolves a command through its shell: \`spawnSync\` on a \`.cmd\` shim fails
 * with EINVAL, so the call goes through \`cmd.exe\` there. This matches the runner in
 * \`apply.ts\`, which the apply path has used on Windows since it shipped.
 *
 * @param cwd - the directory pnpm runs in.
 * @param args - pnpm arguments, without the executable.
 * @param label - the failing step's name, for the error.
 */
function runPnpm(cwd: string, args: readonly string[], label: string): void {
  const result = spawnSync('pnpm', [...args], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(label + ' failed with exit code ' + String(result.status))
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
  const manifestPath = join(paths.profileDirectory, 'package.json')
  const distribution = readDistributionProfile(paths.distributionDirectory)
  if (existsSync(manifestPath)) {
    // The workspace carries decisions the distribution owns — overrides and the build
    // script allowlist — and a distribution release changes them. Rewriting on every
    // start is what lets an upgraded installation receive the new values; a profile
    // written once keeps whatever its own release decided and can never be corrected.
    writeProfileOverrides(paths.profileDirectory, distribution.overrides, distribution.allowBuilds)
    installProfilePackages(paths, consumerDirectory)
    return false
  }
  mkdirSync(paths.profileDirectory, { recursive: true })
  const manifest = {
    name: 'dsh-profile-' + STANDALONE_PROFILE,
    private: true,
    type: 'module',
    dependencies: {
      '@sparkelf/dsh-plus': distribution.version,
      // The launcher's own tree supplies every service package the bundles mount. A
      // profile that lists only the distribution's plugins installs a partial tree and
      // fails at load with a module the launcher would have carried.
      '@deepseek-ai/dsh': distribution.dshRange,
      ...distribution.dependencies,
    },
    dsh: {
      profile: {
        bundles: distribution.bundles,
        patchReload: 'live',
      },
    },
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  // The overrides must reach the workspace before the install that reads them.
  writeProfileOverrides(paths.profileDirectory, distribution.overrides, distribution.allowBuilds)
  installProfilePackages(paths, consumerDirectory)
  return true
}

/**
 * Record the distribution's package substitutions in the profile workspace.
 *
 * pnpm reads \`overrides\` from \`pnpm-workspace.yaml\` since version 10 and ignores the
 * same key in \`package.json\`, so a profile that carried it in the manifest would
 * silently install the official package the override meant to replace.
 *
 * @param profileDirectory - the standalone profile directory.
 * @param overrides - official package name to published replacement spec.
 */
function writeProfileOverrides(
  profileDirectory: string,
  overrides: Readonly<Record<string, string>>,
  allowBuilds: Readonly<Record<string, boolean>>,
): void {
  const workspacePath = join(profileDirectory, 'pnpm-workspace.yaml')
  const document = parseDocument(existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : '')
  const [documentError] = document.errors
  if (documentError !== undefined) throw new Error('Plus profile workspace is not valid YAML', { cause: documentError })
  if (document.get('packages') === undefined) document.set('packages', ['.'])
  for (const [name, spec] of Object.entries(overrides)) document.setIn(['overrides', name], spec)
  // pnpm refuses an install whose packages want to run build scripts until each is
  // decided, so the distribution's reviewed decisions travel with the install rather
  // than waiting for an interactive approval no start can offer.
  for (const [name, allowed] of Object.entries(allowBuilds)) document.setIn(['allowBuilds', name], allowed)
  // The profile resolves bundles from this directory, so peers the official tree would
  // supply have to come from what the consumer installed.
  if (document.get('nodeLinker') === undefined) document.set('nodeLinker', 'hoisted')
  if (document.get('autoInstallPeers') === undefined) document.set('autoInstallPeers', false)
  writeFileSync(workspacePath, String(document))
}

/** Run git in one directory, returning undefined instead of throwing when asked to. */
function git(root: string, args: readonly string[], acceptFailure = false): string | undefined {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status === 0) return result.stdout.trim()
  if (acceptFailure) return undefined
  const detail = result.stderr.trim()
  throw new Error('git ' + args.join(' ') + ' failed' + (detail === '' ? '' : ': ' + detail))
}

/**
 * Apply the reviewed npm-target patches to the profile's installed packages.
 *
 * A standalone installation runs no `apply` step: it installs the distribution from
 * the registry, links the consumer's packages, and starts. The npm patches a
 * distribution declares therefore need an owner that does not require an official
 * source checkout — the source half of the apply step needs one, this does not.
 *
 * The work is idempotent: a patch whose reverse already applies is left alone, so a
 * second start neither re-applies nor fails. A reinstall restores the published bytes,
 * which is why this runs on every start rather than once.
 *
 * @param distributionDirectory - the installed `@sparkelf/dsh-plus` directory.
 * @param profileDirectory - the standalone profile directory.
 * @returns the labels of the patches that were applied.
 */
export function applyProfileNpmPatches(distributionDirectory: string, profileDirectory: string): string[] {
  const manifest = requireRecord(
    JSON.parse(readFileSync(join(distributionDirectory, 'package.json'), 'utf8')) as unknown,
    'Plus distribution manifest',
  )
  const plus = requireRecord(manifest.dshPlus, 'dshPlus')
  const names = plus.patchPackages
  if (!Array.isArray(names)) throw new Error('dshPlus.patchPackages must be an array')
  const applied: string[] = []
  for (const value of names) {
    if (typeof value !== 'string' || value === '') throw new Error('dshPlus.patchPackages entries must be non-empty strings')
    const patchPackage = resolveInstalledPackage(distributionDirectory, value)
    const declaration = requireRecord(patchPackage.manifest.dshPatch, value + ' dshPatch')
    const variants = declaration.variants
    if (!Array.isArray(variants)) throw new Error(value + ' dshPatch.variants must be an array')
    for (const entry of variants) {
      const variant = requireRecord(entry, value + ' variant')
      const target = requireRecord(variant.target, value + ' variant target')
      // Only npm targets reach an installed package; a source target needs the
      // official checkout, which a standalone installation does not have.
      if (target.kind !== 'npm') continue
      const targetName = String(target.name)
      const patched = resolveInstalledPackage(profileDirectory, targetName)
      const file = resolve(patchPackage.directory, String(variant.file))
      if (git(patched.directory, ['apply', '--reverse', '--check', file], true) !== undefined) continue
      git(patched.directory, ['apply', file])
      applied.push(value + ' -> ' + targetName)
    }
  }
  return applied
}

/** One installed package's manifest and directory. */
interface InstalledPackage {
  readonly name: string
  readonly version: string
  readonly directory: string
  readonly manifest: Record<string, unknown>
}

/** Resolve one installed package's manifest from a requiring directory. */
function resolveInstalledPackage(from: string, packageName: string): InstalledPackage {
  const requireFrom = createRequire(join(from, 'package.json'))
  let manifestPath: string
  try {
    manifestPath = requireFrom.resolve(packageName + '/package.json')
  } catch {
    throw new Error(packageName + ' is not installed under ' + from)
  }
  const manifest = requireRecord(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown, packageName + ' manifest')
  return { name: packageName, version: String(manifest.version), directory: dirname(manifestPath), manifest }
}
