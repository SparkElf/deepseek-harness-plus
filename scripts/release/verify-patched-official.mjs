/**
 * Verify a directory of repackaged official workspaces before it is published.
 *
 * Every defect that reached a consumer was invisible to a manifest check: the package
 * installed cleanly, its name resolved, and its files looked right. What caught them was
 * a real installation, and what would have caught them earlier is comparing the packaged
 * output against the official workspace it came from. This does that comparison.
 *
 * Run it between \`package-patched-official.mjs\` and \`publish-patched-official.mjs\`.
 *
 * Usage:
 *   node scripts/release/verify-patched-official.mjs --source <built-checkout> --dir <packaged>
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PACKAGED_FILES, PATCHED_WORKSPACES, OUR_SCOPE } from './package-patched-official.mjs'

/** Read one JSON file or fail with the path that could not be read. */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The official package name behind one repackaged directory. */
function officialName(directory) {
  return '@deepseek-ai/' + directory.replace(/^@sparkelf__/u, '')
}

/** Resolve one workspace's package.json inside the built checkout. */
function workspaceManifest(source, workspace) {
  const path = join(source, workspace, 'package.json')
  if (!existsSync(path)) throw new Error('the checkout has no ' + workspace + '/package.json')
  return { path, manifest: readJson(path), directory: join(source, workspace) }
}

/** Every path a package publishes, resolved through its own files list. */
function publishedPaths(manifest, directory) {
  const files = Array.isArray(manifest.files) && manifest.files.length > 0 ? manifest.files : undefined
  if (files === undefined) return undefined
  const roots = files
    .map(entry => String(entry))
    .filter(entry => !entry.startsWith('!'))
    .map(entry => entry.split('/')[0])
  return [...new Set(roots)].filter(root => existsSync(join(directory, root)))
}

const failures = []

/** Record one failed expectation with the fact that proves it. */
function require_(condition, message) {
  if (!condition) failures.push(message)
}

/** Compare one repackaged package against the workspace it came from. */
function verifyPackage(out, source, workspace) {
  const official = workspaceManifest(source, workspace)
  const ours = join(out, '@sparkelf__' + official.manifest.name.replace('@deepseek-ai/', ''))
  const label = official.manifest.name

  if (!existsSync(join(ours, 'package.json'))) {
    failures.push(label + ': the packaged directory is missing')
    return
  }
  const published = readJson(join(ours, 'package.json'))

  // The installed location keeps the official name, because the built code imports it.
  require_(published.name === official.manifest.name.replace('@deepseek-ai/', OUR_SCOPE),
    label + ': the packaged name is ' + published.name)

  // Nothing the workspace publishes may be dropped, or a consumer installs a package
  // whose own files list promises a directory it does not contain.
  const expected = publishedPaths(official.manifest, official.directory) ?? []
  for (const root of expected) {
    require_(existsSync(join(ours, root)), label + ': the workspace publishes ' + root + ' and the package omits it')
  }

  // Manifest declarations are part of what a package is. dsh.client registers a browser
  // module; dropping it installs cleanly and loads nothing.
  for (const field of ['dsh', 'exports', 'type']) {
    if (official.manifest[field] === undefined) continue
    require_(published[field] !== undefined, label + ': the workspace declares ' + field + ' and the package drops it')
  }

  // Dependencies keep the official names: the built code imports those specifiers, and a
  // dependency renamed onto our scope points at a name nothing asks for.
  for (const field of ['dependencies', 'peerDependencies']) {
    const declared = official.manifest[field] ?? {}
    const carried = published[field] ?? {}
    for (const name of Object.keys(declared)) {
      if (name.startsWith('@sparkelf/')) continue
      require_(carried[name] !== undefined, label + ': the workspace depends on ' + name + ' and the package drops it')
    }
    for (const [name, spec] of Object.entries(carried)) {
      if (!name.startsWith('@deepseek-ai/')) continue
      // A range naming a version the official registry does not serve resolves nothing.
      // When this run republishes under the upstream version the range is correct, so the
      // check only applies to a correction released under our own version.
      if (published.version === official.manifest.version) continue
      require_(!String(spec).includes(published.version),
        label + ': the dependency ' + name + ' names our version ' + String(spec) + ', which the official registry does not serve')
    }
  }
}

function main() {
  const argv = process.argv.slice(2)
  let source
  let out
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--source') { source = argv[index + 1]; index += 1; continue }
    if (argv[index] === '--dir') { out = argv[index + 1]; index += 1; continue }
    throw new Error('unknown option: ' + argv[index])
  }
  if (source === undefined || out === undefined) {
    throw new Error('usage: verify-patched-official.mjs --source <built-checkout> --dir <packaged>')
  }
  const packaged = readdirSync(out).filter(entry => entry.startsWith('@sparkelf__'))
  require_(packaged.length === PATCHED_WORKSPACES.length,
    'packaged ' + String(packaged.length) + ' package(s), expected ' + String(PATCHED_WORKSPACES.length))
  for (const workspace of PATCHED_WORKSPACES) verifyPackage(out, resolve(source), workspace)
  if (failures.length > 0) {
    for (const failure of failures) console.error('  ✗ ' + failure)
    throw new Error('verify-patched-official: ' + String(failures.length) + ' problem(s)')
  }
  console.log('verify-patched-official: ' + String(packaged.length) + ' package(s) match their workspaces')
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main()
}
