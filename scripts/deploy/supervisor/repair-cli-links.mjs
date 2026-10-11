#!/usr/bin/env node
/**
 * Link a release's CLI dependencies so its launcher can start.
 *
 * Why this exists
 * ---------------
 * A release tree can arrive with apps/cli/package.json declaring external packages and no
 * apps/cli/node_modules to resolve them from. Node resolves the launcher's imports from that
 * directory, so the first import fails, web exits before listening, and the supervisor reports
 * 'Harness Web exited before listening'. Measured three times: plus-rc44 (2026-10-01), plus-021a1
 * (2026-10-03), plus-021a4 (2026-10-05) - each switch reported success and left 3080 down.
 *
 * What it does, and what it refuses to do
 * ---------------------------------------
 * For every non-workspace dependency the CLI declares, if the package does not already resolve from
 * apps/cli, it links the highest version present in the release's own .pnpm store that satisfies the
 * declared range. That is the rule package managers use, applied to versions this tree actually
 * contains, so no version is invented. Nothing outside apps/cli/node_modules is written, an existing
 * real directory is never replaced, and a package the store does not contain is reported rather than
 * fetched - a release that lacks a package is a fact about that release, not something to paper over.
 *
 * Exit codes: 0 every declared dependency resolves, 1 something declared still cannot resolve,
 * 2 usage error.
 *
 * Usage: repair-cli-links.mjs --release <release-dir> [--dry-run]
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, symlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : fallback
}
const release = option('--release')
const dryRun = argv.includes('--dry-run')
if (typeof release !== 'string' || release.length === 0) {
  console.log('repair-cli-links: --release is required')
  process.exit(2)
}

/** Parse a leading semver triple, ignoring build metadata. */
function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(text))
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? null }
}

/** Order two parsed versions; a prerelease sorts below its release. */
function compare(a, b) {
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) return a[part] - b[part]
  }
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0
}

/** The exclusive upper bound of a caret range, following the caret's major/minor/patch rule. */
function caretUpper(base) {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0, pre: null }
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0, pre: null }
  return { major: 0, minor: 0, patch: base.patch + 1, pre: null }
}

/** Decide whether a version satisfies one comparator. */
function satisfiesComparator(version, comparator) {
  const text = comparator.trim()
  if (text === '' || text === '*' || text === 'latest') return true
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(text)
  if (match === null) return false
  const operator = match[1] ?? '='
  const operandText = match[2].trim()
  if (operandText === '*' || operandText === '') return true
  const base = parseVersion(operandText)
  if (base === null) return false
  if (operator === '^') {
    return compare(version, base) >= 0 && compare(version, caretUpper(base)) < 0
  }
  if (operator === '~') {
    return compare(version, base) >= 0 && compare(version, { major: base.major, minor: base.minor + 1, patch: 0, pre: null }) < 0
  }
  if (operator === '>=') return compare(version, base) >= 0
  if (operator === '<=') return compare(version, base) <= 0
  if (operator === '>') return compare(version, base) > 0
  if (operator === '<') return compare(version, base) < 0
  // An exact comparator still admits a prerelease of the same triple, which is how ranges such as
  // 0.2.0-rc.1 are written.
  return compare(version, base) === 0 || (version.pre !== null && compare({ ...version, pre: null }, base) === 0)
}

/** Decide whether a version satisfies a range, whose alternatives are separated by ||. */
function satisfies(versionText, range) {
  const version = parseVersion(versionText)
  if (version === null) return false
  return String(range).split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter((piece) => piece.length > 0)
    if (comparators.length === 0) return true
    return comparators.every((comparator) => satisfiesComparator(version, comparator))
  })
}

const cliDir = join(release, 'apps', 'cli')
const cliManifestPath = join(cliDir, 'package.json')
if (!existsSync(cliManifestPath)) {
  console.log('repair-cli-links: no CLI manifest at ' + cliManifestPath)
  process.exit(0)
}

let cliManifest
try {
  cliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8'))
} catch (error) {
  console.log('repair-cli-links: the CLI manifest is unreadable: ' + String(error && error.message))
  process.exit(1)
}

const declared = { ...(cliManifest.dependencies ?? {}), ...(cliManifest.optionalDependencies ?? {}) }
const external = Object.entries(declared).filter(([, range]) => !String(range).startsWith('workspace:'))
const store = join(release, 'node_modules', '.pnpm')
const storeEntries = existsSync(store) ? readdirSync(store) : []

const cliModules = join(cliDir, 'node_modules')
const linked = []
const blocked = []
const notes = []

for (const [name, range] of external) {
  const target = join(cliModules, ...name.split('/'))
  if (existsSync(join(target, 'package.json'))) continue

  // A dangling symlink left by an interrupted run is removed; a real directory is never touched.
  if (existsSync(target) || lstatExists(target)) {
    let isLink = false
    try { isLink = lstatSync(target).isSymbolicLink() } catch { isLink = false }
    if (!isLink) {
      notes.push(name + ': a real directory occupies the link path and was left alone')
      continue
    }
    if (!dryRun) {
      try { unlinkSync(target) } catch (error) {
        notes.push(name + ': could not remove the dangling link: ' + String(error && error.message))
        continue
      }
    }
  }

  const prefix = name.split('/').join('+') + '@'
  const candidates = []
  for (const entry of storeEntries) {
    if (!entry.startsWith(prefix)) continue
    const versionText = entry.slice(prefix.length).split('_')[0]
    if (!satisfies(versionText, range)) continue
    const source = join(store, entry, 'node_modules', ...name.split('/'))
    if (!existsSync(join(source, 'package.json'))) continue
    candidates.push({ entry, versionText, source })
  }
  if (candidates.length === 0) {
    blocked.push(name + ' ' + range + ': no installed version in .pnpm satisfies it')
    continue
  }
  candidates.sort((a, b) => compare(parseVersion(b.versionText), parseVersion(a.versionText)))
  const chosen = candidates[0]

  if (dryRun) {
    linked.push(name + '@' + chosen.versionText + ' (would link)')
    continue
  }
  try {
    mkdirSync(cliModules, { recursive: true })
    symlinkSync(relative(dirname(target), chosen.source), target, 'dir')
    linked.push(name + '@' + chosen.versionText)
  } catch (error) {
    blocked.push(name + ': linking failed: ' + String(error && error.message))
  }
}

/** Report whether a path exists at all, including as a dangling link. */
function lstatExists(path) {
  try { lstatSync(path); return true } catch { return false }
}

for (const line of linked) console.log('repair-cli-links: linked ' + line)
for (const line of notes) console.log('repair-cli-links: note - ' + line)
for (const line of blocked) console.log('repair-cli-links: cannot resolve ' + line)

// Re-check every declared dependency, so the caller learns the post-repair truth rather than only
// what this run changed. A package already present and one just linked are the same answer here.
const unresolved = []
for (const [name] of external) {
  const target = join(cliModules, ...name.split('/'))
  if (!existsSync(join(target, 'package.json'))) unresolved.push(name)
}
if (unresolved.length === 0) {
  console.log('repair-cli-links: all ' + String(external.length) + ' declared dependenc' + (external.length === 1 ? 'y resolves' : 'ies resolve') + (linked.length === 0 ? ' (nothing to repair)' : ''))
  process.exit(0)
}
console.log('repair-cli-links: ' + String(unresolved.length) + ' declared dependenc' + (unresolved.length === 1 ? 'y does not resolve' : 'ies do not resolve') + ': ' + unresolved.join(', '))
process.exit(1)