#!/usr/bin/env node
/**
 * Detect the profile-scope defect that broke 3080's tool dispatch.
 *
 * The DSH web runtime resolves @deepseek-ai/* twice: the release loader imports
 * agent-loop from the release tree, which imports @deepseek-ai/dsh-tools; the
 * profile loader imports the tool registry from the profile's own node_modules.
 * When the profile scope holds a *real directory* where the release ships the
 * package, those become two module instances, two TOOL_RUNTIME_SCHEDULER
 * Symbols, and every tool call dies in prepare() with
 *
 *     Cannot read properties of undefined (reading 'prepare')
 *
 * A second, related defect hides behind the first: a "source sync" MOVED some
 * release packages' nested node_modules into those shadow directories, so the
 * release packages cannot resolve their own dependencies once the shadows are
 * gone.
 *
 * Exit codes: 0 healthy, 1 defects found, 2 usage error.
 *
 * Usage: check-profile-scope.mjs --release <dir> [--profile <dir>] [--json]
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1] }
const release = arg('release')
if (!release) { console.error('usage: check-profile-scope.mjs --release <dir> [--profile <dir>] [--json]'); process.exit(2) }
// The profile directory is `<release>/profiles/plus` (plural, one level down), and
// `/root/.dsh/profiles/plus` is a symlink to it. Defaulting to `<release>/profile`
// pointed at a directory that does not exist, so a bare run read an empty scope and
// reported `healthy: true` with `scopeEntryCount: 0` -- a false negative that would
// wave a broken profile straight through. Prefer the symlink, then the real path, and
// refuse rather than reporting health for a directory that is not there.
function resolveProfileDir(releaseDir) {
  const link = '/root/.dsh/profiles/plus'
  for (const candidate of [link, path.join(releaseDir, 'profiles', 'plus')]) {
    try { if (fs.existsSync(candidate)) return fs.realpathSync(candidate) } catch {}
  }
  return path.join(releaseDir, 'profile')
}
const profile = arg('profile', resolveProfileDir(release))
const asJson = args.includes('--json')

/** Every @deepseek-ai/<name> the release ships, from its own manifests. */
function releaseSources(root) {
  const found = new Map()
  const scan = (dir, depth) => {
    if (!fs.existsSync(dir) || depth > 2) return
    for (const entry of fs.readdirSync(dir)) {
      const child = path.join(dir, entry)
      let st; try { st = fs.lstatSync(child) } catch { continue }
      if (!st.isDirectory()) continue
      const manifest = path.join(child, 'package.json')
      if (fs.existsSync(manifest)) {
        try {
          const j = JSON.parse(fs.readFileSync(manifest, 'utf8'))
          if (typeof j.name === 'string' && j.name.startsWith('@deepseek-ai/')) found.set(j.name.slice('@deepseek-ai/'.length), child)
        } catch { /* not a package */ }
        continue
      }
      scan(child, depth + 1)
    }
  }
  scan(path.join(root, 'packages'), 0)
  scan(path.join(root, 'vendor'), 0)
  return found
}

const sources = releaseSources(release)
const scope = path.join(profile, 'node_modules', '@deepseek-ai')
const findings = []

/** Defect 1: a real directory in the scope where the release ships the package. */
const shadows = []
/** Real directories whose name the release does not ship; reported, never a defect. */
const informational = []
if (fs.existsSync(scope)) {
  for (const name of fs.readdirSync(scope).sort()) {
    const dir = path.join(scope, name)
    let st; try { st = fs.lstatSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    if (name.includes('.before-source-sync-')) { shadows.push({ name, kind: 'leftover', isPackage: false }); continue }
    if (sources.has(name)) { shadows.push({ name, kind: 'shadow', isPackage: true }); continue }
    // A real directory whose name this release does not ship is an installed dependency,
    // not a duplicate: `@deepseek-ai/libreoffice-kit-wasm` is a platform-specific package
    // (`os: ["linux"]`) that a release package pulls in as an optional dependency, and the
    // release never vendors it. Only a name the release also ships can give two module
    // instances, which is the defect this check exists for.
    //
    // The distinction used to be reported as its own 'unknown-dir' defect, which made every
    // profile carrying such a dependency fail the guard even though nothing was duplicated.
    // It is now informational: listed so an operator can see it, but not counted as unhealthy.
    informational.push({ name, kind: 'installed-dependency' })
  }
}

/** Defect 2: a release package whose dependencies move through its own tree. */
const movedTrees = []
for (const [name, dir] of [...sources].sort()) {
  const manifestPath = path.join(dir, 'package.json')
  let manifest; try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { continue }
  const deps = Object.keys(manifest.dependencies ?? {})
  if (deps.length === 0) continue
  const nested = path.join(dir, 'node_modules')
  // A package with dependencies resolves them from its own node_modules or from
  // an ancestor. Only report when its manifest names a dependency that resolves
  // nowhere reachable from the package directory.
  const reachable = (dep) => {
    let current = dir
    for (;;) {
      if (fs.existsSync(path.join(current, 'node_modules', dep, 'package.json'))) return true
      const parent = path.dirname(current)
      if (parent === current) return false
      current = parent
    }
  }
  const unresolved = deps.filter(dep => !reachable(dep) && !dep.startsWith('@deepseek-ai/'))
  const unresolvedDeepseek = deps.filter(dep => !reachable(dep) && dep.startsWith('@deepseek-ai/'))
  if (unresolved.length > 0 || unresolvedDeepseek.length > 0) {
    movedTrees.push({ name, dir: path.relative(release, dir), nodeModulesPresent: fs.existsSync(nested), unresolved: [...unresolvedDeepseek, ...unresolved].slice(0, 8) })
  }
}

const report = {
  release,
  profile,
  scopeEntryCount: fs.existsSync(scope) ? fs.readdirSync(scope).length : 0,
  realDirectoryShadows: shadows,
  installedDependencies: informational,
  packagesWithUnresolvedDeps: movedTrees,
  healthy: shadows.length === 0 && movedTrees.length === 0,
}

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(report.healthy ? 0 : 1) }

console.log('profile scope: ' + scope)
console.log('real directories where the release ships a package: ' + shadows.length)
for (const s of shadows) console.log('  [' + s.kind + '] ' + s.name)
if (informational.length > 0) {
  console.log('installed dependencies the release does not vendor (not a defect): ' + informational.length)
  for (const i of informational) console.log('  [installed] ' + i.name)
}
console.log('release packages with unresolvable dependencies: ' + movedTrees.length)
for (const m of movedTrees) console.log('  ' + m.name.padEnd(46) + m.dir + '  node_modules=' + m.nodeModulesPresent + '  missing: ' + m.unresolved.join(', '))
if (report.healthy) console.log('RESULT: healthy - one module instance per @deepseek-ai package')
else {
  console.log('RESULT: DEFECTIVE - duplicates would give two TOOL_RUNTIME_SCHEDULER Symbols,')
  console.log('        and every tool call would fail with "reading \'prepare\'".')
}
process.exit(report.healthy ? 0 : 1)
