#!/usr/bin/env node
/**
 * Replace real directories that shadow a release package with links to its source.
 *
 * A release mirror ships each @deepseek-ai package once, under packages/<group>/<pkg>
 * or vendor/<name>. The profile's own node_modules/@deepseek-ai scope links to those
 * sources so every importer resolves one module instance — two instances give two
 * TOOL_RUNTIME_SCHEDULER Symbols and every tool call fails with "reading 'prepare'".
 *
 * A profile install can leave a real directory where a link belongs: pnpm hoists a
 * published copy of a package the release also ships. The scope check reports each one
 * as [shadow] and returns DEFECTIVE, and nothing repaired them.
 *
 * Usage: repair-shadowed-scope.mjs --release <mirror> [--profile <dir>] [--check]
 */
import { readdirSync, readFileSync, lstatSync, symlinkSync, unlinkSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
let release
let profile
let checkOnly = false
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--release') { release = resolve(argv[i + 1]); i += 1; continue }
  if (argv[i] === '--profile') { profile = resolve(argv[i + 1]); i += 1; continue }
  if (argv[i] === '--check') { checkOnly = true; continue }
  throw new Error('unknown option: ' + argv[i])
}
if (release === undefined) throw new Error('usage: repair-shadowed-scope.mjs --release <mirror> [--profile <dir>] [--check]')
if (!existsSync(release)) throw new Error('release root does not exist: ' + release)

/**
 * Every `@deepseek-ai/<name>` the release ships and the directory holding it.
 *
 * A workspace directory name is not always the package name, so the manifest decides.
 * The scan is bounded because the mirror is large and the sources sit near the root.
 *
 * @param root - release root.
 * @returns package name to absolute source directory.
 */
function sources(root) {
  const found = new Map()
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // `.pnpm` and every nested `node_modules` hold *copies* of published dependencies,
      // not packages this release ships. Listing them would make a profile-side copy of a
      // transitive dependency look like a duplicate of a release package.
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name.startsWith('.')) continue
      const child = join(dir, entry.name)
      try {
        const manifest = JSON.parse(readFileSync(join(child, 'package.json'), 'utf8'))
        if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/')) {
          found.set(manifest.name.slice('@deepseek-ai/'.length), child)
        }
      } catch { /* not a package root */ }
      walk(child, depth + 1)
    }
  }
  for (const base of ['packages', 'vendor', 'apps', 'native']) walk(join(root, base), 1)
  return found
}

const shipped = sources(release)
const scope = join(profile ?? join(release, 'profile'), 'node_modules', '@deepseek-ai')
if (!existsSync(scope)) {
  console.log('repair-shadowed-scope: no scope at ' + scope + '; nothing to repair')
  process.exit(0)
}

let repaired = 0
let unresolved = 0
for (const name of readdirSync(scope)) {
  const entry = join(scope, name)
  let stat
  try { stat = lstatSync(entry) } catch { continue }
  if (stat.isSymbolicLink()) continue
  const target = shipped.get(name)
  if (target === undefined) {
    // A real directory the release does not ship is a published dependency pnpm
    // hoisted here. It is not a duplicate of a release package, so it is left alone:
    // the scope check reports it only when the release also ships that name.
    continue
  }
  console.log('  [shadow] ' + name + ' -> ' + target.slice(release.length + 1))
  if (checkOnly) continue
  rmSync(entry, { recursive: true, force: true })
  symlinkSync(target, entry)
  repaired += 1
}
console.log('repair-shadowed-scope: repaired ' + String(repaired) + ', unresolved ' + String(unresolved))
