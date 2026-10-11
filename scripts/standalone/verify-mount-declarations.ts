/**
 * Check that every installed package declaring itself a bundle is one the profile mounts.
 *
 * `dshPlus.profile.dependencies` says what to install and `dshPlus.profile.bundles` says what the
 * launcher mounts, and nothing compared them. A package in the first that declares `dsh.bundle` and
 * is missing from the second is installed and never loaded, so the capability it provides is absent
 * while every health check passes.
 *
 * Measured 2026-10-11: `@deepseek-ai/dsh-experimental-auto-review` had been in the plus
 * `dependencies` since 0.2.1-alpha.11 and had never been in the plus `bundles`, so `autoAdmit` was
 * never injected and the permission menu shipped three options instead of four. The dataops variant
 * lists the same package in `includeBundles`, which is why the workspace image had it and the host
 * did not.
 *
 * The manifests are read from the installed profile rather than the repository, because these are
 * published packages: a first version that resolved them under `packages/` and `node_modules/` found
 * three of thirty-three and would have missed the one it was written for.
 *
 * Usage: tsx scripts/standalone/verify-mount-declarations.ts --profile <dir>
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Read one option value, or undefined when it is absent.
 * @param args - the argument list.
 * @param name - the option to look for.
 * @returns the value that follows it, if present.
 */
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

/**
 * Every installed package that declares itself a bundle, found by walking the profile tree.
 *
 * The install lays packages out as symlinks into the store, so a directory test has to resolve them:
 * `readdirSync` reports the link itself and reports it as a symlink rather than a directory.
 * @param nodeModules - the profile node_modules directory.
 * @returns one entry per package that declares `dsh.bundle`.
 */
function declaredBundles(nodeModules: string): { name: string; version: string }[] {
  const found = new Map<string, { name: string; version: string }>()
  const visited = new Set<string>()
  const walk = (dir: string): void => {
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      let isDirectory = entry.isDirectory()
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(full).isDirectory()
        } catch {
          isDirectory = false
        }
      }
      if (!isDirectory) continue
      if (entry.name.startsWith('@')) {
        walk(full)
        continue
      }
      const manifestPath = join(full, 'package.json')
      if (!existsSync(manifestPath)) continue
      try {
        const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown; dsh?: { bundle?: unknown } }
        if (pkg.dsh?.bundle === undefined) continue
        if (typeof pkg.name !== 'string') continue
        found.set(pkg.name, { name: pkg.name, version: String(pkg.version ?? '') })
      } catch { /* a package whose manifest cannot be read is not evidence of anything */ }
    }
  }
  walk(nodeModules)
  return [...found.values()]
}

const args = process.argv.slice(2)
const profileOption = option(args, '--profile')
if (profileOption === undefined) {
  throw new Error('usage: verify-mount-declarations.ts --profile <dir>')
}
const profile = resolve(profileOption)
const manifestPath = join(profile, 'package.json')
if (!existsSync(manifestPath)) throw new Error('verify-mount-declarations: no ' + manifestPath)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: unknown } }
}
const mounted = manifest.dsh?.profile?.bundles
if (!Array.isArray(mounted)) {
  throw new Error('verify-mount-declarations: ' + manifestPath + ' declares no dsh.profile.bundles')
}
const mountedSet = new Set(mounted as string[])

// A package that publishes its own bundle and is installed but not mounted is the failure this
// checks. Mounted packages are skipped, and so is anything the profile does not install.
const problems: string[] = []
const bundles = declaredBundles(join(profile, 'node_modules'))
const installed = new Set(Object.keys(manifest.dependencies ?? {}))
if (bundles.length === 0) {
  throw new Error('verify-mount-declarations: found no package declaring dsh.bundle under ' + profile)
}
for (const entry of bundles.sort((a, b) => a.name.localeCompare(b.name))) {
  if (mountedSet.has(entry.name)) continue
  if (!installed.has(entry.name)) continue
  problems.push(entry.name + '@' + entry.version + ' declares dsh.bundle and the profile installs it, but no bundle entry mounts it')
}

if (problems.length > 0) {
  for (const problem of problems) console.error('verify-mount-declarations: ' + problem)
  console.error('')
  console.error('The launcher mounts exactly the bundles `dsh.profile.bundles` names, so installing a')
  console.error('bundle without naming it there leaves its capability absent while every health check')
  console.error('passes. Add it to `dshPlus.profile.bundles` in packages/bundle/plus/package.json.')
  process.exit(1)
}
console.log(
  'verify-mount-declarations: all ' + String(bundles.length) + ' installed bundle declaration(s) are mounted',
)
