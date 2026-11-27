#!/usr/bin/env node
/**
 * Point the profile's patched packages at the source checkout built in this image.
 *
 * A registry installation of the distribution redirects each patched official package to a
 * republished build. Those builds are released on their own schedule, so a profile assembled
 * today can receive a build cut from an older official revision: measured 2026-11-05,
 * `@sparkelf/dsh-native-command` exported one symbol where the official alpha.2 package the
 * boot layer imports exported thirteen. This image builds the official source itself and
 * `dsh-plus apply` links those workspaces into the profile, so the redirects are removed and
 * the registry keeps serving only the packages the patch set does not touch.
 *
 * Usage: node rewrite-profile-deps.mjs --profile <dir> --source <checkout> --distribution <plus dir>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const value = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const profile = value('--profile')
const source = value('--source')
const distribution = value('--distribution')
const distributionTarball = value('--distribution-tarball')
if (profile === undefined || source === undefined || distribution === undefined) {
  throw new Error('usage: rewrite-profile-deps.mjs --profile <dir> --source <checkout> --distribution <plus dir>')
}

const distributionManifest = JSON.parse(readFileSync(join(distribution, 'package.json'), 'utf8'))
const entries = distributionManifest.dshPlus?.patchSet?.entries ?? []
const profilePath = join(profile, 'package.json')
const profileManifest = JSON.parse(readFileSync(profilePath, 'utf8'))

/** Workspace directories one patch entry owns, by the package name each declares. */
const workspaces = new Map()
for (const entry of entries) {
  if (entry.target?.kind !== 'dsh-source' || entry.target.republish === false) continue
  for (const prefix of entry.target.paths ?? []) {
    const directory = resolve(source, prefix)
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.name !== undefined) workspaces.set(manifest.name, directory)
  }
}

/**
 * Every redirect the profile currently carries, keyed by the official name it replaces.
 *
 * The entry is REMOVED rather than pointed at the workspace: a `file:` dependency on a pnpm
 * workspace fails to install because the workspace's own manifest declares `workspace:` ranges
 * (ERR_PNPM_WORKSPACE_PKG_NOT_FOUND). `dsh-plus apply` links the built workspaces into the
 * profile's official scope after its install, which is the supported path.
 */
const removed = []
const unresolved = []
for (const [name, spec] of Object.entries(profileManifest.dependencies ?? {})) {
  if (typeof spec !== 'string' || !spec.startsWith('npm:@sparkelf/')) continue
  if (!workspaces.has(name)) {
    unresolved.push(name)
    continue
  }
  removed.push(name)
}
for (const name of removed) delete profileManifest.dependencies[name]

// The registry serves a publication of the same version that predates this build. The profile
// installs the distribution from the tarball this image was built from, so the metadata it
// resolves -- and that `dsh-plus apply` re-reads for its own decisions -- is this build's.
if (distributionTarball !== undefined) {
  profileManifest.dependencies['@sparkelf/dsh-plus'] = 'file:' + distributionTarball
}
writeFileSync(profilePath, JSON.stringify(profileManifest, null, 2) + '\n')

// The workspace file overrides the same names; an override would win over the dependency and pull
// the registry build back in, so the rewritten names are removed from it.
const workspacePath = join(profile, 'pnpm-workspace.yaml')
if (existsSync(workspacePath)) {
  const keep = []
  const removedSet = new Set(removed)
  for (const line of readFileSync(workspacePath, 'utf8').split('\n')) {
    const match = /^\s+"?(@?[^":]+)"?:\s/.exec(line)
    if (match !== null && removedSet.has(match[1])) continue
    keep.push(line)
  }
  writeFileSync(workspacePath, keep.join('\n'))
}

console.log(JSON.stringify({
  removed: removed.length,
  unresolved,
  remainingRedirects: Object.values(profileManifest.dependencies ?? {})
    .filter(spec => typeof spec === 'string' && spec.startsWith('npm:@sparkelf/')).length,
}))