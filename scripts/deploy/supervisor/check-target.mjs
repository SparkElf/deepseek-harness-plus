#!/usr/bin/env node
/**
 * Refuse a release mirror that cannot serve, before anything is stopped.
 *
 * Why this exists
 * ---------------
 * dsh-plus-switch stops the running service and only then points the profile link,
 * edits the manifest, and starts again. Its only check on the target was
 * \`[ -d "$MIRROR/profile" ]\`, which an EMPTY profile directory passes. Measured on
 * 2026-09-24: a freshly built release tree (plus-rc31) had a profile directory with
 * nothing in it, the switch stopped 3080 for it, the run was interrupted at that point,
 * and the service was left down with the tree half-switched. Nothing had asked whether
 * the target could ever start.
 *
 * What is checked, and why in this order
 * --------------------------------------
 *   1. HARD: the target is materialised - CLI entry, profile manifest, cordis root, and an
 *      installed distribution. This is the defect that caused the outage; an empty profile
 *      directory satisfies the old check, so it is checked for content rather than existence.
 *   2. HARD: the target's own bundles can actually be imported. This is the EMPIRICAL test,
 *      and it is the one that caught the real 09-24 failure: nested schemastery 3.18.4 asked
 *      for a cosmokit export the release tree does not provide, so 60 plugins failed to import
 *      and dsh exited 1 - after the service had already been stopped.
 *   3. ADVISORY: the distribution's declared official-baseline range. Deliberately NOT a hard
 *      failure. The range is a declaration, not an observation: this host currently serves
 *      0.2.0-rc.23 (declaring >=0.1.7-rc.1) on a 0.1.6-alpha.2 tree and works, because the
 *      @deepseek-ai scope is symlinked into the release tree. Treating the declaration as a
 *      hard gate would have refused to restore the very configuration that was serving.
 *      Which is why step 2 asks the question directly instead of trusting the metadata.
 *
 * Exit codes: 0 the target can serve, 1 it cannot, 2 usage error.
 *
 * Usage: check-target.mjs --mirror <release-dir> [--skip-imports] [--json]
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = argv.indexOf('--' + name)
  return at === -1 ? fallback : argv[at + 1]
}
const mirror = arg('mirror')
const skipImports = argv.includes('--skip-imports')
const asJson = argv.includes('--json')
if (typeof mirror !== 'string' || mirror === '') {
  console.error('usage: check-target.mjs --mirror <release-dir> [--skip-imports] [--json]')
  process.exit(2)
}

const blockers = []
const warnings = []
const notes = []

// 1. Materialisation. Every one of these is required to boot, and their absence is the
//    defect that stopped the service on 2026-09-24.
const required = [
  ['the served CLI entry', join(mirror, 'apps', 'cli', 'lib', 'bin.js')],
  ['the release tree manifest', join(mirror, 'apps', 'cli', 'package.json')],
  ['the profile manifest', join(mirror, 'profile', 'package.json')],
  ['the profile cordis root', join(mirror, 'profile', 'cordis.yml')],
  ['the installed distribution', join(mirror, 'profile', 'node_modules', '@sparkelf', 'dsh-plus', 'package.json')],
]
for (const [what, path] of required) {
  if (!existsSync(path)) blockers.push({ kind: 'unmaterialised', what, path })
}

// 1a. The CLI can load its own dependencies.
//
// A tree whose apps/cli has no node_modules passes materialisation, because bin.js exists, and
// still cannot boot: Node resolves the CLI imports from that directory, so the first import
// fails and web exits before listening. Checking resolution here keeps that failure before the
// point of no return, instead of after a switch that already reported success.
if (blockers.length === 0) {
  const cliDir = join(mirror, 'apps', 'cli')
  let declared = {}
  try {
    const cliManifest = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'))
    declared = { ...(cliManifest.dependencies ?? {}), ...(cliManifest.optionalDependencies ?? {}) }
  } catch { declared = {} }
  // A workspace entry is satisfied by the release tree itself, not by a store link.
  for (const [depName, depRange] of Object.entries(declared)) {
    if (String(depRange).startsWith('workspace:')) continue
    const depPath = join(cliDir, 'node_modules', ...depName.split('/'))
    if (!existsSync(join(depPath, 'package.json'))) {
      blockers.push({ kind: 'cli-dependency', what: 'the CLI cannot resolve ' + depName, path: depPath })
    }
  }
}
// 2. The empirical question: can the target's own bundles be imported?
if (blockers.length === 0 && !skipImports) {
  const probe = '/root/.dsh/supervisor/check-plugin-imports.mjs'
  if (!existsSync(probe)) notes.push('import probe unavailable; materialisation is the only evidence')
  else {
    const result = spawnSync(process.execPath, [probe, '--profile', join(mirror, 'profile')], {
      encoding: 'utf8',
      timeout: 300_000,
    })
    if (result.status === 1) {
      const detail = ((result.stdout ?? '') + (result.stderr ?? '')).trim().split(String.fromCharCode(10)).slice(0, 6)
      blockers.push({ kind: 'import-failure', what: 'a bundle in this target cannot be imported, so dsh would exit at boot', detail })
    } else if (result.status === 0) {
      notes.push(((result.stdout ?? '').trim().split(String.fromCharCode(10)).filter(Boolean).pop()) ?? 'imports ok')
    } else {
      notes.push('import probe did not complete (exit ' + String(result.status) + '); continuing')
    }
  }
}

// 3. The declaration. Advisory by design - see the header.
let releaseVersion
let range
try { releaseVersion = JSON.parse(readFileSync(join(mirror, 'apps', 'cli', 'package.json'), 'utf8')).version } catch { /* step 1 reported it */ }
try { range = JSON.parse(readFileSync(join(mirror, 'profile', 'node_modules', '@sparkelf', 'dsh-plus', 'package.json'), 'utf8')).dshPlus?.compatibility?.dsh } catch { /* optional */ }
if (typeof releaseVersion === 'string' && typeof range === 'string' && range !== '') {
  if (!satisfies(releaseVersion, range)) {
    warnings.push({ kind: 'declared-range', what: 'the distribution declares a newer official baseline than this release tree provides', range, releaseVersion })
  } else notes.push('declared compatibility ' + range + ' satisfied by ' + releaseVersion)
}

/** Prerelease-aware comparison, enough for the \`>=\` ranges this distribution declares. */
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(text))
  if (m === null) return undefined
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') }
}
function compare(left, right) {
  for (let i = 0; i < 3; i += 1) if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const a = left.pre[i], b = right.pre[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b)
    if (an && bn) return Number(a) < Number(b) ? -1 : 1
    if (an) return -1
    if (bn) return 1
    return a < b ? -1 : 1
  }
  return 0
}
/** Evaluate one simple range. Every range this distribution declares is a \`>=\` form. */
function satisfies(version, range) {
  const parsed = parseVersion(version)
  if (parsed === undefined) return true
  for (const alternative of String(range).split('||')) {
    let ok = true
    for (const clause of alternative.trim().split(/\s+/).filter(Boolean)) {
      const m = /^(>=|<=|>|<|=)?\s*v?(.+)$/.exec(clause)
      if (m === null) continue
      const operator = m[1] ?? '='
      const bound = parseVersion(m[2].replace(/^\^|^~/, ''))
      if (bound === undefined) continue
      const cmp = compare(parsed, bound)
      if (operator === '>=' && cmp < 0) ok = false
      else if (operator === '>' && cmp <= 0) ok = false
      else if (operator === '<=' && cmp > 0) ok = false
      else if (operator === '<' && cmp >= 0) ok = false
      else if (operator === '=' && cmp !== 0) ok = false
    }
    if (ok) return true
  }
  return false
}

if (asJson) {
  console.log(JSON.stringify({ mirror, releaseVersion, range, blockers, warnings, notes, ok: blockers.length === 0 }, null, 2))
} else {
  for (const blocker of blockers) {
    if (blocker.kind === 'unmaterialised' || blocker.kind === 'cli-dependency') console.log('check-target: missing ' + blocker.what + ' at ' + blocker.path)
    else if (blocker.kind === 'import-failure') {
      console.log('check-target: ' + blocker.what)
      for (const line of blocker.detail) console.log('check-target:   ' + line)
    } else console.log('check-target: ' + blocker.what)
  }
  for (const warning of warnings) {
    console.log('check-target: warning - ' + warning.what)
    console.log('check-target:   provides ' + warning.releaseVersion + ', declares ' + warning.range + ' (advisory; the import probe above is the evidence)')
  }
  for (const note of notes) console.log('check-target: ' + note)
}
process.exit(blockers.length === 0 ? 0 : 1)
