#!/usr/bin/env node
/**
 * Carry the state a new release mirror cannot derive into it.
 *
 * A mirror's sources are built from the distribution, but three things live inside a running
 * profile rather than in its sources, and a fresh profile starts without any of them:
 *
 *   - `.dsh-plus/patches/` — the reviewed patches applied to published plugin packages;
 *   - `cordis.patch.yml` — the deployment's own loader layer (default model, plugin config);
 *   - `compatibility.json` — already written by the exemptions step, so it is left alone.
 *
 * Losing the first costs every patched plugin its patch. Losing the second costs whatever the
 * operator configured by hand. Measured 2026-09-30: a promotion that did not carry these lost
 * 18 patch directories and the default-model row, and the model selection fell back to none.
 *
 * The previous release is the only authority for this state, so it is named explicitly rather
 * than guessed: a promotion passes the mirror it is replacing.
 *
 * Usage: carry-profile-state.mjs --from <previous mirror> --to <new mirror> [--check]
 */
import { existsSync, cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    'from-profile': { type: 'string' },
    'to-profile': { type: 'string' },
    check: { type: 'boolean', default: false },
  },
})

// The profile can be named directly, because a release mirror keeps it at profiles/plus while
// an older layout kept it at profile.
const fromProfile = values['from-profile'] ?? join(values.from ?? '', 'profile')
const toProfile = values['to-profile'] ?? join(values.to ?? '', 'profile')

if (fromProfile === 'profile' || toProfile === 'profile' || fromProfile === '' || toProfile === '') {
  console.error('usage: carry-profile-state.mjs (--from <mirror> --to <mirror> | --from-profile <dir> --to-profile <dir>) [--check]')
  process.exit(2)
}

if (!existsSync(fromProfile)) {
  console.error('carry-profile-state: no profile at ' + fromProfile)
  process.exit(2)
}
if (!existsSync(toProfile)) {
  console.error('carry-profile-state: no profile at ' + toProfile)
  process.exit(2)
}

let carried = 0

// The patch directories name their version, so a stale one is not carried: only the packages
// the new release still reviews are copied, and only at the version the new distribution pins.
const fromPatches = join(fromProfile, '.dsh-plus', 'patches')
const toPatches = join(toProfile, '.dsh-plus', 'patches')
if (existsSync(fromPatches)) {
  const scopes = readdirSync(fromPatches)
  for (const scope of scopes) {
    const scopeDir = join(fromPatches, scope)
    if (!existsSync(join(toPatches, scope))) {
      if (!values.check) cpSync(scopeDir, join(toPatches, scope), { recursive: true })
      carried += 1
    }
  }
  console.log('carry-profile-state: patch scopes -> ' + String(carried) + ' carried')
  console.log('  patches present: ' + String(countPatches(fromPatches)))
} else {
  console.log('carry-profile-state: no patch directories in ' + fromProfile)
}

// The loader layer is the deployment's configuration. A new mirror ships a template, so it is
// replaced whole: merging two YAML documents by text would decide ownership of each row, and
// the previous release already resolved that.
const fromLayer = join(fromProfile, 'cordis.patch.yml')
const toLayer = join(toProfile, 'cordis.patch.yml')
if (existsSync(fromLayer)) {
  const previous = readFileSync(fromLayer, 'utf8')
  // A layer that is only the template has nothing to carry, and overwriting the new template
  // with it would hide the comment that explains what the file is for.
  const rows = previous.split('\n').filter((line) => /^-\s+id:\s*\S/.test(line))
  if (rows.length > 0) {
    if (!values.check) cpSync(fromLayer, toLayer)
    console.log('carry-profile-state: loader layer carried (' + String(rows.length) + ' configured row(s))')
  } else {
    console.log('carry-profile-state: previous loader layer configures nothing; left the new template')
  }
} else {
  console.log('carry-profile-state: no loader layer in ' + fromProfile)
}

// The composition is the profile's own list of what to mount, and a newly created profile has
// only the distribution default. A deployment's composition is a reviewed choice: it names the
// plugins this deployment runs, and replacing it with the default is what silently drops them.
// Measured 2026-09-30: a mirror built without this step carried 19 of a deployment's 24
// dependencies and none of its three extra bundles, and the panels those bundles register were
// missing from the GUI while every gate reported success.
const fromManifest = JSON.parse(readFileSync(join(fromProfile, 'package.json'), 'utf8'))
const toManifest = JSON.parse(readFileSync(join(toProfile, 'package.json'), 'utf8'))
const fromProfileBlock = fromManifest.dsh?.profile ?? {}
const toProfileBlock = toManifest.dsh?.profile ?? {}
const composed = { ...(fromManifest.dependencies ?? {}) }
// Every package the new release itself declares is what that release ships; carrying the
// previous release's range forward would pin the new mirror to the old build. This covers the
// whole `@sparkelf` family, not a hand-listed subset: measured 2026-10-01, a mirror built with
// the subset served dsh-plus rc.32, the skill center rc.34, and backup rc.41 while reporting
// rc.44, because those rows kept the previous deployment's ranges.
for (const [name, range] of Object.entries(toManifest.dependencies ?? {})) {
  composed[name] = range
}
// The packages the release itself pins, read from the installed wrapper rather than from
// the profile: a fresh profile declares the wrapper, and the wrapper is what names the
// plugin versions this release ships.
const releasePins = {}
for (const [name, range] of Object.entries(toManifest.dependencies ?? {})) {
  if (!String(name).endsWith('-standalone')) continue
  try {
    const wrapper = JSON.parse(readFileSync(join(toProfile, 'node_modules', String(name), 'package.json'), 'utf8'))
    for (const [inner, innerRange] of Object.entries(wrapper.dependencies ?? {})) releasePins[inner] = innerRange
  } catch { /* the wrapper is not installed; the profile keeps its own pins */ }
}
// The wrapper is skipped: it is the profile entry that names them, and it already carries
// the release version from the profile block the loop above merged.
for (const [name, range] of Object.entries(releasePins)) {
  if (String(name).endsWith('-standalone')) continue
  composed[name] = range
}

const fromBundles = fromProfileBlock.bundles ?? []
const toBundles = toProfileBlock.bundles ?? []
const bundles = [...new Set([...toBundles, ...fromBundles])]
const changed = JSON.stringify(composed) !== JSON.stringify(toManifest.dependencies ?? {})
  || JSON.stringify(bundles) !== JSON.stringify(toBundles)
if (values.check) {
  console.log(changed
    ? 'carry-profile-state: the new profile does not carry the composition (' + String(Object.keys(composed).length) + ' dep(s), ' + String(bundles.length) + ' bundle(s))'
    : 'carry-profile-state: the composition is carried')
  process.exit(changed ? 1 : 0)
}
if (changed) {
  toManifest.dependencies = composed
  toManifest.dsh = { ...(toManifest.dsh ?? {}), profile: { ...toProfileBlock, bundles } }
  writeFileSync(join(toProfile, 'package.json'), JSON.stringify(toManifest, null, 2) + '\n')
  console.log('carry-profile-state: composition carried (' + String(Object.keys(composed).length) + ' dep(s), ' + String(bundles.length) + ' bundle(s))')
  console.log('  the profile needs an install for the added dependencies')
} else {
  console.log('carry-profile-state: composition already matches')
}

/** Count the patch files under a directory tree. */
function countPatches(root) {
  let total = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (entry.name.endsWith('.patch')) total += 1
    }
  }
  try { walk(root) } catch { /* a tree that cannot be read reports what it counted */ }
  return total
}
