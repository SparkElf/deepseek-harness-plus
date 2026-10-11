#!/usr/bin/env node
/**
 * One pre-start interlock for the 3080 runtime: repair, verify, then accept.
 *
 * Why this exists: the service was found failed twice for two different reasons, and
 * both were cheap to fix but invisible from the outside.
 *
 *   1. The supervisor's profile guard refuses a start when the accepted profile
 *      closure changed (a plugin install, a patch merge, a pnpm-lock rewrite). The
 *      unit then restarts on a 10s timer until StartLimitBurst trips, and the journal
 *      holds one bare exit code. Nothing about 3080 says "re-accept the profile".
 *   2. A real directory under profile/node_modules/@deepseek-ai where the release
 *      ships the same package gives two module instances of @deepseek-ai/dsh-tools,
 *      two TOOL_RUNTIME_SCHEDULER Symbols, and every tool call fails with
 *      "Cannot read properties of undefined (reading 'prepare')" - while HTTP stays
 *      200 and the page looks alive.
 *
 * The second defect is the dangerous one: it does not stop the service, it silently
 * breaks every message. So the interlock runs the scope checker, repairs a definite
 * defect through the supported tool (originals are moved, never deleted), and proves
 * one module instance before any accept happens.
 *
 * Order: (0) repair the known defect classes a runtime replacement reintroduces, (1) repair
 * profile scope, (2) prove module identity, (3) import the profile's own plugins, (4) re-accept a
 * stale fingerprint. Acceptance comes last on purpose: it is the step that says "this profile is
 * fit to serve", so it must not run before every defect is gone. Each earlier step answers a
 * question the later ones cannot: the scope fence sees duplicate package names, module identity
 * sees two resolvers, the import smoke sees a nested dependency that disagrees with the release
 * tree while every name resolves cleanly, and step 0 covers the defects that live in files a
 * promote overwrites - none of the other checks read those files.
 *
 * Fail-closed only on a positive defect. A checker that is missing, crashes, or
 * prints nothing is reported and passes: this fence must never be the reason 3080
 * cannot start. The same doctrine as preflight-profile-scope.mjs.
 *
 * Usage: preflight-start.mjs [--dry-run]
 */
import { execFileSync, spawnSync  } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, symlinkSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SUPERVISOR = '/root/.dsh/supervisor'
const MANIFEST = join(SUPERVISOR, 'runtime.json')
const STATE = join(SUPERVISOR, 'accepted-profile.json')
const PROFILE_LINK = '/root/.dsh/profiles/plus'
const CHECKER = join(SUPERVISOR, 'check-profile-scope.mjs')
const REPAIR = join(SUPERVISOR, 'repair-profile-scope.mjs')
// Restores a release package own node_modules links to the profile copies. repair-profile-scope
// removes duplicate scope entries but cannot make a release package resolve a dependency that only
// the profile holds, which is the defect measured on 2026-09-28: mcp-client could not find
// @modelcontextprotocol/client and every tool call failed until the link was restored by hand.
const NESTED = join(SUPERVISOR, 'fix-nested-links.mjs')
const IDENTITY = join(SUPERVISOR, 'check-module-identity.mjs')
const KNOWN = join(SUPERVISOR, 'repair-known-defects.mjs')
const GUARD = join(SUPERVISOR, 'profile-guard.mjs')

const DRY = process.argv.includes('--dry-run')
const LF = String.fromCharCode(10)

/** Every line goes to stderr: the unit routes stderr to the journal. */
function say(...parts) { process.stderr.write('[interlock] ' + parts.join(' ') + LF) }
function refuse(message) { say('REFUSED - ' + message); process.exit(1) }

function run(script, args, timeout) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    failed: result.error !== undefined,
  }
}

function stamp() { return new Date().toISOString().replace(/[:.]/gu, '-') }

function acceptedAt() {
  try { return Date.parse(JSON.parse(readFileSync(STATE, 'utf8')).acceptedAt) } catch { return 0 }
}

/**
 * Newest modification inside a package, walking directories only.
 *
 * Comparing the package directory alone misses a file rewritten in place: the fingerprint
 * covers lib/, patches/, runtime/, package.json and cordis.patch.yml, so replacing one
 * file inside lib/ changes the closure while the directory mtime stays put. Measured:
 * the audit line named an unrelated package because of exactly that. The walk stops at
 * the first hit, so a changed package is still cheap; only unchanged ones recurse.
 */
function newestInside(entry, since, depth) {
  let at = 0
  try { at = lstatSync(entry).mtimeMs } catch { return 0 }
  if (at > since) return at
  if (depth <= 0) return 0
  let entries = []
  try { entries = readdirSync(entry, { withFileTypes: true }) } catch { return 0 }
  for (const child of entries) {
    if (!child.isDirectory()) continue
    const found = newestInside(join(entry, child.name), since, depth - 1)
    if (found > 0) return found
  }
  return 0
}

/**
 * Packages whose contents are newer than the last acceptance.
 * This is the audit line: it names what changed right before the fingerprint did.
 */
function changedPackages(profileRoot, since, limit = 20) {
  const modules = join(profileRoot, 'node_modules')
  const found = []
  const consider = (name, dir) => {
    const at = newestInside(dir, since, 2)
    if (at > 0) found.push({ name, at })
  }
  let entries = []
  try { entries = readdirSync(modules, { withFileTypes: true }) } catch { return [] }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const dir = join(modules, entry.name)
    if (entry.name.startsWith('@')) {
      let scoped = []
      try { scoped = readdirSync(dir) } catch { continue }
      for (const child of scoped) consider(entry.name + '/' + child, join(dir, child))
    } else consider(entry.name, dir)
  }
  return found.sort((a, b) => b.at - a.at).slice(0, limit).map(entry => entry.name)
}

/**
 * Import the profile's own root plugins and report the first that throws.
 *
 * A profile can pass the scope fence, have one module instance, and still be unable to boot:
 * a nested dependency can be older or newer than the release tree's own copy of the same
 * package. Measured on this host - a rolled-back profile kept nested schemastery 3.18.4 from
 * a later release, which imports createVolatile from @deepseek-ai/cosmokit; the release tree
 * vendors cosmokit 1.8.3 with no such export, so 60 plugins failed to import and dsh exited 1
 * while HTTP still answered from the previous process.
 *
 * The imports are dynamic and sequential: each failure is attributed to the plugin that threw,
 * and a plugin that hangs only costs its own timeout. The check asks the same question the
 * loader will ask at boot, so it fails closed on a definite import error and passes when the
 * probe cannot run at all.
 *
 * @param root - the profile directory whose node_modules are probed.
 * @returns the first failing package and its message, or undefined when all imports succeed.
 */
function importSmoke(root, timeout) {
  const probe = join(SUPERVISOR, 'check-plugin-imports.mjs')
  if (!existsSync(probe)) return { missing: true }
  const result = spawnSync(process.execPath, [probe, '--profile', root], { encoding: 'utf8', timeout })
  if (result.error !== undefined) return { missing: true }
  if (result.status === 0) return { passed: true, output: (result.stdout ?? '').trim() }
  if (result.status === 1) return { failed: true, output: ((result.stdout ?? '') + (result.stderr ?? '')).trim() }
  return { missing: true }
}

if (!existsSync(MANIFEST)) refuse('no supervisor manifest at ' + MANIFEST)
let manifest
try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) } catch (error) { refuse('unreadable manifest: ' + error.message) }
const release = resolve(manifest.runtime?.cwd ?? '')
if (!existsSync(release)) refuse('the manifest runtime cwd does not exist: ' + release)
// Read the link's TARGET once, before the guard can restore it. resolve() alone is not enough:
// it is lexical, so the path would stay spelled as the link and every later read would follow
// whatever the link points at by then. Measured 2026-09-24: a switch pointed the link at rc31,
// the guard restored it to rc30, and the accept that followed re-accepted rc30 because it
// re-read the link - so the switch could never move the deployment.
let profileRoot
try { profileRoot = existsSync(PROFILE_LINK) ? realpathSync(PROFILE_LINK) : join(release, 'profile') } catch { profileRoot = join(release, 'profile') }
say('release ' + release + ' profile ' + profileRoot)

// 0. Known defects: the classes a runtime replacement reintroduces, which no later check
//    reads. A promote or a pnpm install rewrites the supervisor runtime and the plus bundle, so a
//    fix that lives only on disk is reverted the next time either moves. Measured 2026-09-25: a
//    promote to 0.1.7-rc.2 restored an unguarded settings.yaml read (ENOENT on every publish), an
//    unguarded error response (ERR_HTTP_HEADERS_SENT killed the process), and the retired
//    subagent-settings mount (which fails the whole browser boot). The repair is idempotent and
//    scoped to the tree being started.
if (DRY) say('known defect repair skipped (dry run)')
else if (!existsSync(KNOWN)) say('known defect repair unavailable; continuing')
else {
  const repaired = run(KNOWN, ['--release', release, '--profile', profileRoot], 300_000)
  const lines = (repaired.stdout ?? '').split(LF).filter(Boolean)
  for (const line of lines) say(line)
  if (repaired.status !== 0) refuse('a known defect could not be repaired: ' + lines.join(' | '))
}

// 1. Profile scope: one module instance per @deepseek-ai package.
let scopeHealthy
if (DRY) say('scope check skipped (dry run)')
else {
  const checked = run(CHECKER, ['--release', release, '--json'], 120_000)
  let report
  try { report = JSON.parse(checked.stdout) } catch { report = undefined }
  if (report === undefined) {
    say('scope check produced no report (exit ' + String(checked.status) + '); continuing')
  } else if (report.healthy === true) {
    say('scope ok: ' + String(report.scopeEntryCount) + ' entries, no duplicate package')
    scopeHealthy = true
  } else {
    const shadows = (report.realDirectoryShadows ?? []).map(entry => '[' + entry.kind + '] ' + entry.name)
    const broken = (report.packagesWithUnresolvedDeps ?? []).map(entry => entry.name)
    say('defect: duplicate @deepseek-ai packages in the profile scope: ' + shadows.join(', ') +
      (broken.length === 0 ? '' : ' unresolved deps: ' + broken.join(', ')))
    if (!existsSync(REPAIR)) refuse('the scope defect is present and ' + REPAIR + ' is missing')
    const backup = join('/root/.dsh/backups', 'profile-scope-auto-' + stamp())
    const repaired = run(REPAIR, ['--release', release, '--backup', backup], 600_000)
    if (repaired.status !== 0) {
      refuse('scope repair failed (exit ' + String(repaired.status) + '): ' + repaired.stderr.trim().slice(-400))
    }
    say('repaired: originals preserved under ' + join(backup, 'manifest.json'))
    const recheck = run(CHECKER, ['--release', release, '--json'], 120_000)
    let again
    try { again = JSON.parse(recheck.stdout) } catch { again = undefined }
    if (again === undefined || again.healthy !== true) {
      // The scope repair removes duplicate entries; it cannot supply a dependency the release
      // package resolves from its own node_modules. When the surviving defect is exactly that,
      // restoring the links clears it, so try that before refusing.
      const left = ((again ?? report).packagesWithUnresolvedDeps ?? []).length
      if (left > 0 && existsSync(NESTED)) {
        say('scope repair left ' + String(left) + ' package(s) with unresolved deps; restoring nested links')
        const linked = run(NESTED, ['--release', release], 300_000)
        for (const line of (linked.stdout ?? '').split(LF).filter(Boolean)) say(line)
        if (linked.status === 0) {
          const relinked = run(CHECKER, ['--release', release, '--json'], 120_000)
          let settled
          try { settled = JSON.parse(relinked.stdout) } catch { settled = undefined }
          if (settled !== undefined && settled.healthy === true) {
            say('scope ok after nested-link repair')
            scopeHealthy = true
          }
        }
      }
      if (scopeHealthy !== true) {
        refuse('scope repair did not clear the defect; every tool call would fail with ' +
          '"reading prepare". Inspect ' + join(backup, 'manifest.json'))
      }
    }
    say('scope ok after repair')
    scopeHealthy = true
  }
}

// 2. Module identity: the direct question, asked before anything is accepted.
if (DRY) say('module identity check skipped (dry run)')
else {
  const identity = run(IDENTITY, ['--release', release], 120_000)
  if (identity.status === 1) {
    refuse('two module instances - every tool call would fail with "reading prepare"' + LF + identity.stdout.trim())
  }
  if (identity.status !== 0) say('module identity check did not complete (exit ' + String(identity.status) + '); continuing')
  else say(identity.stdout.trim().split(LF).filter(Boolean).pop() ?? 'module identity ok')
}

// 3. Import smoke: the question the scope fence cannot answer. A nested dependency can
//    disagree with the release tree while every name resolves to one file.
if (DRY) say('plugin import smoke skipped (dry run)')
else {
  const smoke = importSmoke(profileRoot, 300_000)
  if (smoke.missing === true) say('plugin import smoke unavailable; continuing')
  else if (smoke.failed === true) {
    refuse('a profile plugin cannot be imported, so dsh would exit at boot:' + LF + smoke.output.split(LF).slice(0, 8).join(LF))
  } else say('plugin imports ok: ' + (smoke.output.split(LF).filter(Boolean).pop() ?? ''))
}

// 4. Fingerprint acceptance, with the audit line the bare guard never printed.
//
// The guard answers exit 0 in TWO different situations, and only one of them means "valid":
//
//   - the accepted fingerprint still matches AND the link already points at that profile;
//   - the fingerprint matches but the link points somewhere ELSE, in which case the guard
//     REWRITES the link back to the accepted profile and still exits 0, reporting
//     {"restored":true,"previousProfile":"<what the link said>"}.
//
// Reading only the exit status therefore mistakes a revert for a pass. Measured 2026-09-24: a
// switch pointed the link at rc31, this step saw exit 0, printed "fingerprint valid", and the
// start put the link back on rc30 - so every switch ended with "serving plus-rc30 but plus-rc31
// was requested". The restore is the signal that an acceptance is due for the new target.
// 3b. CLI link repair.
//
// A release can arrive with apps/cli/package.json declaring external packages and no
// apps/cli/node_modules to resolve them from. Node resolves the launcher imports from that
// directory, so the first import fails, web exits before listening, and the supervisor reports
// Harness Web exited before listening, leaving 3080 down on a switch that reported success.
// Measured three times: plus-rc44, plus-021a1, plus-021a4. This is the one path every start
// takes, so the repair runs here, before anything reads the profile.
if (!DRY) {
  const repair = '/root/.dsh/supervisor/repair-cli-links.mjs'
  if (!existsSync(repair)) say('CLI link repair unavailable; the launcher may fail to resolve its imports')
  else {
    const repaired = run(repair, ['--release', release], 120_000)
    for (const line of String(repaired.stdout ?? '').split(String.fromCharCode(10)).filter(Boolean)) say(line.trim())
    if (repaired.status !== 0) say('the launcher still cannot resolve every declared dependency; continuing so the checks below decide')
  }
}
// 4a. Link/manifest consistency, unless a switch is mid-flight.
//
// The link decides which profile the runtime loads and the manifest decides which runtime starts.
// When they name different releases the runtime is one version and its plugins another, and a tool
// call then fails while reading prepare, because the scheduler symbol it looks up belongs to the
// module instance the loaded plugins did not come from.
//
// A switch moves the link, accepts, rewrites the manifest, then reloads, so the two legitimately
// disagree in between and must be left alone then. A running switch owns its own systemd unit, so
// that unit is what this check waits for; a stale phase log would not do, since it outlives the run.
if (!DRY) {
  // A switch owns both a process and a transient unit. The process check comes first because it
  // does not depend on unit-name formatting; the unit scan catches a detached switch whose script
  // name a future refactor changes.
  const switchInProgress = () => {
    try {
      const found = execFileSync('pgrep', ['-f', 'dsh-plus-switch'], { encoding: 'utf8', timeout: 30_000 })
      if (found.split(String.fromCharCode(10)).some((line) => line.trim().length > 0)) return true
    } catch { /* pgrep exits nonzero when nothing matches */ }
    try {
      const units = execFileSync('systemctl', ['list-units', '--all', '--plain', '--no-legend', 'dsh-plus-switch-*'], { encoding: 'utf8', timeout: 60_000 })
      return units.split(String.fromCharCode(10)).some((line) => / running( |$)/.test(line))
    } catch { return false }
  }
  if (switchInProgress()) say('a switch is in progress; leaving the link and manifest alone')
  else {
    let manifestCwd
    try { manifestCwd = JSON.parse(readFileSync(MANIFEST, 'utf8'))?.runtime?.cwd } catch { manifestCwd = undefined }
    if (typeof manifestCwd === 'string' && manifestCwd.length > 0 && existsSync(manifestCwd)) {
      const expectedProfile = join(manifestCwd, 'profile')
      let linked
      try { linked = realpathSync(PROFILE_LINK) } catch { linked = undefined }
      if (linked !== undefined && existsSync(expectedProfile) && linked !== expectedProfile) {
        say('link/manifest consistency: the link points at ' + linked + ' but the manifest runs ' + manifestCwd)
        say('restoring the link to the manifest profile; the runtime and its plugins must be one release')
        try {
          symlinkSync(expectedProfile, PROFILE_LINK + '.manifest-next', 'dir')
          renameSync(PROFILE_LINK + '.manifest-next', PROFILE_LINK)
          profileRoot = expectedProfile
          say('link restored to ' + expectedProfile)
        } catch (error) {
          say('could not restore the link: ' + String(error && error.message).slice(0, 200))
        }
      }
    }
  }
}
const guarded = run(GUARD, ['guard', '--state', STATE], 300_000)
let restored
try { restored = JSON.parse(guarded.stdout) } catch { restored = undefined }
const reverted = restored !== undefined && restored.restored === true
if (guarded.status === 0 && !reverted) say('fingerprint valid: profile unchanged since the last acceptance')
else {
  if (reverted) {
    say('the guard restored the link to the previously accepted profile (' +
      String(restored.previousProfile ?? '?') + ' -> ' + String(restored.acceptedProfile ?? '?') + ')')
    say('so this profile is not the accepted one yet; accepting it for ' + profileRoot)
  }
  const changed = changedPackages(profileRoot, acceptedAt())
  say('profile closure changed since the last acceptance' + (changed.length === 0 ? '' : ': ' + changed.join(', ')))
  if (DRY) say('re-accept skipped (dry run)')
  else {
    // Point the link back at the target the caller asked for before accepting, so the accept
    // names the profile the manifest will actually run and the guard stops restoring.
    try { symlinkSync(profileRoot, PROFILE_LINK + '.next', 'dir'); renameSync(PROFILE_LINK + '.next', PROFILE_LINK) } catch { /* a real directory here is refused below by the guard */ }
    const accepted = run(GUARD, [
      'accept', '--profile', profileRoot, '--profile-link', PROFILE_LINK,
      '--manifest', MANIFEST, '--state', STATE,
    ], 300_000)
    if (accepted.status !== 0) refuse('re-accept failed: ' + accepted.stderr.trim().slice(-400))
    // A reverted guard means the link was moved back; accept names profileRoot and rewrites the
    // link, so re-point it first and then confirm the guard stops reverting.
    const verified = run(GUARD, ['guard', '--state', STATE], 300_000)
    let settled
    try { settled = JSON.parse(verified.stdout) } catch { settled = undefined }
    if (verified.status !== 0) refuse('the fingerprint is still invalid after re-accept')
    if (settled !== undefined && settled.restored === true) {
      refuse('the guard keeps restoring the link to ' + String(settled.acceptedProfile) +
        ' instead of accepting ' + profileRoot)
    }
    say('re-accepted: the runtime will start on the profile that just passed both checks')
  }
}

say('passed' + (scopeHealthy === true ? ' (scope repaired or already healthy)' : ''))
process.exit(0)
