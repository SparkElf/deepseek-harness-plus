#!/usr/bin/env node
/**
 * Relink a DSH release checkout's @deepseek-ai scope to its own packages and
 * vendor sources.
 *
 * The release tree ships its sources under `packages/<group>/<pkg>` and
 * `vendor/<name>`, and each declares the package name `@deepseek-ai/<name>`.
 * Two consumers resolve those names at different depths:
 *
 *   - the profile's own `node_modules` (the CLI's plugin imports), and
 *   - anything inside the release, including `vendor/schemastery`, which walks
 *     up from its own directory and lands on `<release>/node_modules` first.
 *
 * A `pnpm install` run inside the release rewrites that scope down to whatever
 * the install declared, which is a handful of plugin packages. The sources stay
 * on disk, so every plugin then fails to import with
 * `Cannot find package '@deepseek-ai/cosmokit'`.
 *
 * This restores the links the release needs, from the sources it ships.
 *
 * Usage:
 *   relink-release.mjs --release <release-root> [--check] [--profile <dir>]
 */
import { readdirSync, existsSync, readFileSync, symlinkSync, lstatSync, unlinkSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
let release
let checkOnly = false
let profile
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--release') { release = resolve(argv[i + 1]); i += 1; continue }
  if (argv[i] === '--profile') { profile = resolve(argv[i + 1]); i += 1; continue }
  if (argv[i] === '--check') { checkOnly = true; continue }
  throw new Error('unknown option: ' + argv[i])
}
if (release === undefined) throw new Error('usage: relink-release.mjs --release <release-root> [--check] [--profile <dir>]')
if (!existsSync(release)) throw new Error('release root does not exist: ' + release)

/**
 * Every `@deepseek-ai/<name>` this release ships.
 *
 * A workspace's directory name is not always its package name (`llm-pi-ai` vs
 * its manifest name), so the manifest decides.
 *
 * @param root - release root.
 * @returns package name to source directory.
 */
function sources(root) {
  const found = new Map()
  const scan = (dir, depth) => {
    if (!existsSync(dir) || depth > 2) return
    for (const entry of readdirSync(dir)) {
      const child = join(dir, entry)
      try { if (!lstatSync(child).isDirectory()) continue } catch { continue }
      const manifest = join(child, 'package.json')
      if (existsSync(manifest)) {
        try {
          const j = JSON.parse(readFileSync(manifest, 'utf8'))
          if (typeof j.name === 'string' && j.name.startsWith('@deepseek-ai/')) found.set(j.name.slice('@deepseek-ai/'.length), child)
        } catch { /* an unreadable manifest is not a package */ }
        continue
      }
      scan(child, depth + 1)
    }
  }
  scan(join(root, 'packages'), 0)
  scan(join(root, 'vendor'), 0)
  return found
}

/**
 * Point `scope/<name>` at `source`, replacing a wrong or broken link.
 *
 * A real directory at that path belongs to whoever installed it — the profile's
 * scope is populated by `pnpm` as well — so it is left alone rather than
 * replaced. Only links this function owns are rewritten.
 *
 * @param scope - `@deepseek-ai` directory to populate.
 * @param name - package name below the scope.
 * @param source - directory in the release the name resolves to.
 * @returns true when the link was missing or wrong.
 */
function link(scope, name, source) {
  const at = join(scope, name)
  let existing
  try { existing = lstatSync(at) } catch { existing = undefined }
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) {
      try { if (realpathSync(at) === realpathSync(source)) return false } catch { /* broken link */ }
    } else {
      // An installed copy, not a link: not this function's to move.
      return false
    }
  }
  if (checkOnly) return true
  try { unlinkSync(at) } catch { /* nothing there to remove */ }
  try { symlinkSync(source, at, 'dir') } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  return true
}

const found = sources(release)
const targets = []
const scope = join(release, 'node_modules', '@deepseek-ai')
if (!checkOnly) mkdirSync(scope, { recursive: true })
for (const [name, source] of found) targets.push([scope, name, source])
if (profile !== undefined) {
  const profileScope = join(profile, 'node_modules', '@deepseek-ai')
  if (!checkOnly) mkdirSync(profileScope, { recursive: true })
  for (const [name, source] of found) targets.push([profileScope, name, source])
}

const missing = []
for (const [dir, name, source] of targets) if (link(dir, name, source)) missing.push(name)
console.log('relink-release: ' + found.size + ' package(s) in the source tree')
console.log('relink-release: ' + (checkOnly ? 'would link ' : 'linked ') + missing.length + ' link(s)' + (checkOnly ? '' : ' across ' + (profile === undefined ? 1 : 2) + ' scope(s)'))
for (const name of missing.slice(0, 10)) console.log('  ' + name)
if (missing.length > 10) console.log('  ... and ' + (missing.length - 10) + ' more')
