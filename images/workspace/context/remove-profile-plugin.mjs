/**
 * Remove one reviewed plugin from an assembled DSH profile template.
 *
 * The registry standalone pins the plugin in both `dependencies` and
 * `dsh.profile.bundles`. Dropping only one of those leaves either an
 * unresolved bundle row or an installed package that the profile still
 * advertises. This helper removes both, and the installed package, so a
 * clean image does not carry a disabled language pack.
 *
 * Usage: node remove-profile-plugin.mjs <profile-dir> <package-name> [...]
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [profileDirectory, ...names] = process.argv.slice(2)
if (!profileDirectory || names.length === 0) {
  console.error('remove-profile-plugin: expected <profile-dir> <package-name> [...]')
  process.exit(2)
}

const manifestPath = join(profileDirectory, 'package.json')
if (!existsSync(manifestPath)) {
  console.error('remove-profile-plugin: no package.json under ' + profileDirectory)
  process.exit(2)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
for (const name of names) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (manifest[field] && Object.prototype.hasOwnProperty.call(manifest[field], name)) {
      delete manifest[field][name]
    }
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    manifest.dsh.profile.bundles = bundles.filter((bundle) => bundle !== name)
  }
  const installed = join(profileDirectory, 'node_modules', name)
  if (existsSync(installed)) rmSync(installed, { recursive: true, force: true })
  console.log('removed profile plugin: ' + name)
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
