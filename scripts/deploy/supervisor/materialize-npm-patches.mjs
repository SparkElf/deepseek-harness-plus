/**
 * Write the Plus distribution's npm patch packages into the profile's pnpm patch config.
 *
 * `dsh-plus apply` is what normally does this, and the image cannot run it: that command
 * resolves the official DSH source root and refuses a checkout whose HEAD is not the
 * distribution's exact base revision, while a registry installation has no checkout at all.
 * The command was reachable in the image that built DSH from a git revision, so the registry
 * rewrite left the step out — and an installed patch package is indistinguishable from an
 * applied one, so every later assertion still passed.
 *
 * This runs before the profile's own install, so the entries are present when pnpm first reads
 * the workspace: the install that already happens is the one that applies the patches, and no
 * second install is needed. Running it afterwards does not work — the lockfile the first install
 * wrote then disagrees with these entries, and pnpm refuses the frozen install it triggers.
 *
 * Only `target.kind === "npm"` variants are handled here. The `dsh-source` variants patch the
 * official packages, and those ship already patched: the standalone installation substitutes
 * them through its overrides, so there is no checkout to patch and nothing here should try.
 *
 * Patch packages are resolved from the distribution, and the target from the profile: that is
 * where each one is installed, and it mirrors how `dsh-plus apply` chooses between them.
 *
 * Usage: node materialize-npm-patches.mjs --profile <profile-dir> --distribution <plus-dir>
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * Whether `version` satisfies `range`.
 *
 * The helper runs before the profile has any node_modules, so it cannot import semver, and the
 * ranges here are the small subset the distribution writes: a comparator, a space-joined set of
 * comparators, or a `||`-separated list of those. Prerelease versions compare by their numeric
 * parts, which is enough to place `0.24.1` inside `>=0.21.1 <0.25.0`.
 */
function satisfies(version, range) {
  const target = numericParts(version)
  if (target === null) return false
  return range.split('||').some(alternative =>
    alternative.trim().split(/\s+/).filter(part => part !== '').every(part => comparatorSatisfied(target, part)))
}

/** The numeric release parts of a version, ignoring any prerelease or build suffix. */
function numericParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim())
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Compare two numeric release tuples: negative, zero, or positive. */
function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

/** Whether one comparator such as `>=0.21.1` admits a version. */
function comparatorSatisfied(target, comparator) {
  const match = /^(>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)/.exec(comparator)
  if (match === null) throw new Error('unsupported version range comparator: ' + comparator)
  const bound = [Number(match[2]), Number(match[3]), Number(match[4])]
  const order = compare(target, bound)
  switch (match[1]) {
    case '>': return order > 0
    case '>=': return order >= 0
    case '<': return order < 0
    case '<=': return order <= 0
    case undefined:
    case '=': return order === 0
    default: throw new Error('unsupported version range comparator: ' + comparator)
  }
}

/** Read `key: value` entries of a top-level YAML block, enough for the workspace file we own. */
function readYamlBlock(text, key) {
  const lines = text.split(String.fromCharCode(10))
  const start = lines.findIndex(line => line === key + ':')
  if (start === -1) return null
  const entries = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (!line.startsWith(' ')) break
    const match = /^\s+("?)([^":]+)\1:\s*(.*)$/u.exec(line)
    if (match !== null) entries.push([match[2], match[3].trim().replace(/^["']|["']$/gu, '')])
  }
  return { start, end: start + entries.length, entries }
}

const argv = process.argv.slice(2)
let profileDirectory
let distributionDirectory
for (let index = 0; index < argv.length; index += 2) {
  if (argv[index] === '--profile') profileDirectory = resolve(argv[index + 1] ?? '')
  else if (argv[index] === '--distribution') distributionDirectory = resolve(argv[index + 1] ?? '')
  else throw new Error('usage: node materialize-npm-patches.mjs --profile <profile-dir> --distribution <plus-dir>')
}
if (profileDirectory === undefined || distributionDirectory === undefined) {
  throw new Error('usage: node materialize-npm-patches.mjs --profile <profile-dir> --distribution <plus-dir>')
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/** Read an installed package's manifest, or undefined when it is absent. */
function installed(base, name) {
  const manifest = join(base, 'node_modules', ...name.split('/'), 'package.json')
  return existsSync(manifest) ? readJson(manifest) : undefined
}

/** The directory an installed package occupies, for resolving its own dependencies. */
const packageDirectory = (base, name) => join(base, 'node_modules', ...name.split('/'))

const profileManifest = readJson(join(profileDirectory, 'package.json'))
const profileDependencies = profileManifest.dependencies ?? {}
// The distribution is named by its own package directory, and the root that holds it under
// node_modules is where its patch packages are installed beside it.
const distribution = readJson(join(distributionDirectory, 'package.json'))
if (distribution.name !== '@sparkelf/dsh-plus') {
  throw new Error(distributionDirectory + ' declares ' + String(distribution.name) + ', not @sparkelf/dsh-plus')
}
// <root>/node_modules/@sparkelf/dsh-plus -> <root>, where the patch packages are installed
// beside the distribution. Derived from the path rather than read from a config so the helper
// works against both the install tree and a profile that carries its own copy.
const distributionRoot = resolve(distributionDirectory, '..', '..', '..')
if (!existsSync(join(distributionRoot, 'node_modules', '@sparkelf', 'dsh-plus', 'package.json'))) {
  throw new Error(distributionDirectory + ' is not a scoped package under a node_modules root')
}

const patchPackageNames = distribution.dshPlus?.patchPackages
if (!Array.isArray(patchPackageNames) || patchPackageNames.length === 0) {
  throw new Error('the Plus distribution declares no dshPlus.patchPackages')
}

/**
 * The version of an npm patch target.
 *
 * The profile's own install may not have run yet, so the version comes from what the profile
 * manifest asks for; an `npm:` alias (the omitted-capability substitution) names the version
 * after its last `@`. A target already installed is read from the tree instead, because that is
 * the version the patch will actually be applied to.
 */
/**
 * The package name pnpm keys a patch by.
 *
 * A profile may install a package under one name and resolve it to another: the distribution
 * declares `@deepseek-ai/dsh-client-ui-permission-presets` as
 * `npm:@sparkelf/dsh-client-ui-permission-presets@<version>`, so the directory carries the
 * official name while the bytes come from the republished one. pnpm keys `patchedDependencies`
 * by the package that owns the bytes — the aliased name — and rejects the dependency's own name
 * with `ERR_PNPM_UNUSED_PATCH`, because no installed package answers to it.
 * @param name - Dependency name as the profile declares it.
 * @returns The name to key the patch entry by.
 */
function targetPatchName(name) {
  const spec = profileDependencies[name]
  if (typeof spec !== 'string') return name
  return /^npm:(@[^/]+\/[^@]+)@/.exec(spec)?.[1] ?? name
}

/** The version a patch target resolves to, read from the installed tree or the declaration. */
function targetVersion(name) {
  const present = installed(profileDirectory, name)
  if (present !== undefined) return present.version
  const spec = profileDependencies[name]
  if (typeof spec !== 'string') {
    throw new Error(name + ' is neither installed in the profile nor declared by it, so its version is unknown')
  }
  const version = /^npm:(?:@[^/]+\/)?[^@]+@(.+)$/.exec(spec)?.[1] ?? spec
  if (version === '' || /^[\^~><=*| ]/.test(version)) {
    throw new Error(name + ' is declared as ' + spec + ', which names no exact version to patch')
  }
  return version
}

/** Where pnpm reads patchedDependencies from, and where the patch files live. */
const workspacePath = join(profileDirectory, 'pnpm-workspace.yaml')
const patchRoot = join(profileDirectory, '.dsh-plus', 'patches')
rmSync(patchRoot, { recursive: true, force: true })

const selected = []
for (const name of patchPackageNames) {
  // Patch packages are installed beside the distribution, so the directory holding it is the one
  // holding them. The distribution's own package directory sits under that root's node_modules.
  const packageRoot = join(distributionRoot, 'node_modules', ...name.split('/'))
  const patchPackage = existsSync(join(packageRoot, 'package.json')) ? readJson(join(packageRoot, 'package.json')) : undefined
  if (patchPackage === undefined) throw new Error('the distribution does not install ' + name)
  for (const variant of patchPackage.dshPatch?.variants ?? []) {
    if (variant.target?.kind !== 'npm') continue
    const range = variant.target.range
    if (typeof range !== 'string' || range.trim() === '') {
      throw new Error(name + ' declares a target range that is not a semver range: ' + String(range))
    }
    const version = targetVersion(variant.target.name)
    if (!satisfies(version, range, { includePrerelease: true })) {
      throw new Error(name + ' targets ' + variant.target.name + '@' + range + ', and the profile installs ' + version)
    }
    // The patch file travels inside the patch package; it is data, not a module, so the path is
    // joined rather than resolved.
    const source = join(packageRoot, variant.file.replace(/^\.\//u, ''))
    if (!existsSync(source)) throw new Error(name + ' ships no patch at ' + variant.file)
    selected.push({
      id: variant.id ?? name,
      name,
      version: patchPackage.version,
      source,
      target: { name: variant.target.name, patchName: targetPatchName(variant.target.name), version },
    })
  }
}

if (selected.length === 0) throw new Error('the Plus distribution declares no npm patch variant')

// One patch file per target: pnpm keys patchedDependencies by name@version, so several patches
// for one target have to travel as one file, in the order the distribution lists them.
const groups = new Map()
for (const patch of selected) {
  // Keyed by the name that owns the bytes: for an aliased dependency that is the alias, not the
  // name the profile declared it under.
  const key = patch.target.patchName + '@' + patch.target.version
  const group = groups.get(key) ?? []
  group.push(patch)
  groups.set(key, group)
}

/**
 * One parsed patch: the per-file sections it touches, in file order.
 *
 * pnpm applies a patch with its own applier, not `git apply`, and that applier reads each file
 * section's own header. Files are collected first so every hunk for one file lands in one
 * section, in ascending order.
 * @param text - one patch file's content.
 * @returns the file sections, each with its header lines, hunks, and target path.
 */
function patchSections(text) {
  const sections = []
  let current = null
  const lines = text.split(String.fromCharCode(10))
  if (lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) {
    // A file section starts at its `--- a/<path>` line and holds every hunk that follows until
    // the next one, including after a `diff --git` of its own. Restarting the section at that
    // header split one file's hunks across two sections that each carried the same path, which
    // pnpm then refused.
    if (line.startsWith('--- ')) {
      current = { path: line.slice(4).replace(/^[ab]\//u, '').trim(), hunks: [], hunk: null }
      sections.push(current)
      continue
    }
    if (current === null) continue
    if (line.startsWith('@@')) {
      current.hunk = [line]
      current.hunks.push(current.hunk)
      continue
    }
    // A hunk ends at the next header. The blank line a trailing newline leaves behind is not
    // part of the body: counting it made pnpm reject the merged patch with "hunk header
    // integrity check failed" while git apply accepted the same bytes.
    if (current.hunk !== null
      && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\'))) {
      current.hunk.push(line)
    }
  }
  return sections
}

/**
 * A hunk header's two line counts: how many lines it removes and how many it writes.
 * @param hunk - one hunk, as its header line plus its body lines.
 * @returns the header's two starts and two counts.
 */
function hunkCounts(hunk) {
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(hunk[0])
  return {
    oldStart: Number(header?.[1] ?? '0'),
    oldCount: header?.[2] === undefined ? 1 : Number(header[2]),
    newStart: Number(header?.[3] ?? '0'),
    newCount: header?.[4] === undefined ? 1 : Number(header[4]),
  }
}

/**
 * Merge the patches targeting one package into the single file pnpm reads.
 *
 * Concatenating the files does not work. pnpm applies a patch with its own applier rather than
 * `git apply`, and it resolves one file section at a time, so a second section for a path reads
 * the file the first section already changed. Measured 2026-10-14: a combined file of the
 * explorer last-modified patch plus the three existing better-sidebar patches failed every
 * install attempt with `ERR_PNPM_PATCH_FAILED`, while each patch applied alone succeeded and
 * `git apply` accepted the concatenation.
 *
 * The merged hunks also have to be renumbered. Every patch was written against the unmodified
 * file, so a patch that runs after an earlier one moves down by however much that earlier patch
 * grew the file. The gap comes from the line counts a hunk header states, not from counting its
 * body: a hunk whose context lines the two sides do not share would drift by one per hunk. This
 * is the shape the distribution's own `dsh-plus apply` writes.
 *
 * @param patches - the group's patches, in the order the distribution lists them.
 * @returns the merged patch text.
 */
function mergePatches(patches) {
  const byPath = new Map()
  for (const patch of patches) {
    for (const section of patchSections(readFileSync(patch.source, 'utf8'))) {
      // The patches arrive in the distribution's order, so a file's sections stay in the order
      // those patches were written.
      const entry = byPath.get(section.path) ?? []
      byPath.set(section.path, entry)
      entry.push(section)
    }
  }
  const out = []
  for (const [path, sections] of byPath) {
    out.push('diff --git a/' + path + ' b/' + path)
    out.push('--- a/' + path)
    out.push('+++ b/' + path)
    // Each section is shifted by the growth of the sections whose hunks sit above it, so the
    // sections are ordered by where they land in the file rather than by which patch wrote them.
    // Keeping the patch order moved a patch's hunks below an earlier patch's, and the "+" side
    // then pointed at the wrong lines.
    sections.sort((left, right) => hunkCounts(left.hunks[0]).oldStart - hunkCounts(right.hunks[0]).oldStart)
    let shift = 0
    for (const section of sections) {
      for (const hunk of section.hunks) {
        const counts = hunkCounts(hunk)
        const trailer = hunk[0].slice(hunk[0].indexOf('@@', 2) + 2)
        hunk[0] = '@@ -' + String(counts.oldStart)
          + (counts.oldCount === 1 ? '' : ',' + String(counts.oldCount))
          + ' +' + String(counts.newStart + shift)
          + (counts.newCount === 1 ? '' : ',' + String(counts.newCount))
          + ' @@' + trailer
      }
      shift += section.hunks.reduce((grow, hunk) => {
        const counts = hunkCounts(hunk)
        return grow + counts.newCount - counts.oldCount
      }, 0)
    }
    out.push(...sections.flatMap(section => section.hunks.flat()))
  }
  return out.join(String.fromCharCode(10)) + String.fromCharCode(10)
}

const patchedDependencies = {}
for (const [key, group] of groups) {
  const destination = group.length === 1
    ? join(patchRoot, group[0].name, 'patch.patch')
    : join(patchRoot, 'combined', key.replaceAll('/', '%2F') + '.patch')
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, group.length === 1
    ? readFileSync(group[0].source, 'utf8')
    : mergePatches(group))
  patchedDependencies[key] = relative(profileDirectory, destination).replaceAll('\\', '/')
  console.log('  ' + key + ' <- ' + group.map(patch => patch.id).join(' + '))
}

// Written as text rather than through a YAML round-trip: this runs before the profile has any
// node_modules, so a parser dependency is not available, and the only key touched is one this
// helper owns. Comments and every other key are preserved because the file is edited line-wise.
const workspaceText = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : ''
const nextEntries = Object.entries(patchedDependencies)
  .map(([key, file]) => '  ' + JSON.stringify(key) + ': ' + file)
const block = readYamlBlock(workspaceText, 'patchedDependencies')
if (block === null) {
  const separator = workspaceText === '' || workspaceText.endsWith(String.fromCharCode(10)) ? '' : String.fromCharCode(10)
  writeFileSync(workspacePath, workspaceText + separator + 'patchedDependencies:' + String.fromCharCode(10)
    + nextEntries.join(String.fromCharCode(10)) + String.fromCharCode(10))
} else {
  const lines = workspaceText.split(String.fromCharCode(10))
  const replacement = nextEntries.join(String.fromCharCode(10))
  const head = lines.slice(0, block.start + 1).join(String.fromCharCode(10))
  const tail = lines.slice(block.end + 1).join(String.fromCharCode(10))
  writeFileSync(workspacePath, head + String.fromCharCode(10) + replacement + String.fromCharCode(10) + tail)
}

const lockPath = join(profileDirectory, '.dsh-plus', 'patchset.lock.json')
writeFileSync(lockPath, JSON.stringify({
  formatVersion: 1,
  distribution: { name: distribution.name, version: distribution.version },
  patches: selected.map(patch => ({
    id: patch.id,
    patchPackage: { name: patch.name, version: patch.version },
    file: patchedDependencies[patch.target.patchName + '@' + patch.target.version],
    target: { kind: 'npm', name: patch.target.name, version: patch.target.version },
  })),
}, null, 2) + String.fromCharCode(10))

console.log('materialize-npm-patches: ' + String(selected.length) + ' npm patch(es) for '
  + String(groups.size) + ' target(s); lock ' + relative(profileDirectory, lockPath))
