/**
 * Check that the distribution declares exactly the patch packages that exist, and that every
 * source patch is anchored to the base revision the distribution records.
 *
 * Two silent failures motivated this. `dsh-plus-mirror` selects patches by globbing
 * `patches/npm/*`, so a directory added without a `dshPlus.patchPackages` entry is applied without
 * ever appearing in the reviewed set, and one removed while its declaration stays is skipped with
 * nothing to notice the difference. Separately, a source patch carries the official revision it was
 * written against, and nothing compared that against the base the distribution now pins: after a
 * base upgrade a stale anchor keeps applying under `git apply --3way`, which reconciles a moved
 * hunk by context and reports success.
 *
 * Measured 2026-10-11, before the check existed: the declaration held 23 entries and the directory
 * held 23 packages, so the sets happened to agree - but nothing enforced it, and no gate reported a
 * count of applied patches to compare against.
 *
 * Usage: tsx scripts/standalone/verify-patch-manifest.ts [--repo <dir>]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Read one option value, or undefined when it is absent.
 * @param args - the argument list.
 * @param name - the option to look for.
 * @returns the value that follows it, if present.
 */
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

interface PatchEntry {
  directory: string
  name: string
  kinds: string[]
  baseRevisions: string[]
}

/**
 * Every patch package in the directory, with the target kind and any base revision each variant names.
 * @param patchRoot - the `patches/npm` directory.
 * @returns one entry per package that carries a manifest.
 */
function readPatches(patchRoot: string): PatchEntry[] {
  const entries: PatchEntry[] = []
  for (const directory of readdirSync(patchRoot).sort()) {
    const manifestPath = join(patchRoot, directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: unknown
      dshPatch?: { variants?: { target?: { kind?: unknown; baseRevision?: unknown } }[] }
    }
    const variants = manifest.dshPatch?.variants ?? []
    const kinds = [...new Set(variants.map(variant => String(variant.target?.kind ?? '')))]
    const baseRevisions = [
      ...new Set(
        variants
          .filter(variant => variant.target?.kind === 'dsh-source')
          .map(variant => String(variant.target?.baseRevision ?? '')),
      ),
    ]
    if (typeof manifest.name !== 'string' || manifest.name === '') {
      throw new Error('verify-patch-manifest: ' + directory + ' has no package name')
    }
    entries.push({ directory, name: manifest.name, kinds, baseRevisions })
  }
  return entries
}

const args = process.argv.slice(2)
const repo = resolve(option(args, '--repo') ?? '/root/projects/deepseek-harness-plus')
const distribution = join(repo, 'packages/bundle/plus/package.json')
const patchRoot = join(repo, 'patches/npm')
if (!existsSync(distribution)) throw new Error('verify-patch-manifest: no ' + distribution)
if (!existsSync(patchRoot)) throw new Error('verify-patch-manifest: no ' + patchRoot)

const plus = JSON.parse(readFileSync(distribution, 'utf8')) as {
  dshPlus?: { patchPackages?: unknown; sourceBase?: { revision?: unknown } }
}
const declared = plus.dshPlus?.patchPackages
if (!Array.isArray(declared) || declared.some(entry => typeof entry !== 'string')) {
  throw new Error('verify-patch-manifest: dshPlus.patchPackages must be an array of strings')
}
const sourceBase = plus.dshPlus?.sourceBase?.revision
if (typeof sourceBase !== 'string' || sourceBase === '') {
  throw new Error('verify-patch-manifest: dshPlus.sourceBase.revision must be a non-empty string')
}

const patches = readPatches(patchRoot)
const problems: string[] = []

// Both directions. A declaration without a directory is a package the reviewed set claims to carry
// and the build will not apply; a directory without a declaration is applied without ever being
// reviewed. Reporting only one direction would let the other drift.
const declaredSet = new Set(declared as string[])
const actualSet = new Set(patches.map(entry => entry.name))
for (const name of [...declaredSet].sort()) {
  if (!actualSet.has(name)) problems.push('declared but absent from patches/npm: ' + name)
}
for (const entry of patches) {
  if (!declaredSet.has(entry.name)) problems.push('present in patches/npm but undeclared: ' + entry.name + ' (' + entry.directory + ')')
}

// A source patch states the official revision it was written against. The distribution states the
// base it now pins. A mismatch means the patch was not revisited for this base, and the only reason
// it still applies is the fuzz-tolerant tool in the mirror.
let sourcePatches = 0
for (const entry of patches) {
  if (!entry.kinds.includes('dsh-source')) continue
  sourcePatches += 1
  if (entry.baseRevisions.length !== 1) {
    problems.push(entry.name + ': a source variant must name exactly one baseRevision, found ' + String(entry.baseRevisions.length))
    continue
  }
  const anchor = entry.baseRevisions[0]
  if (anchor === '') {
    problems.push(entry.name + ': source variant has no baseRevision')
    continue
  }
  if (anchor !== sourceBase) {
    problems.push(
      entry.name + ': baseRevision ' + anchor + ' does not match dshPlus.sourceBase.revision ' + sourceBase +
      ', so it was not revisited for the base this distribution pins',
    )
  }
}
if (sourcePatches === 0) problems.push('no source patch found, so the base anchor was never checked')

if (problems.length > 0) {
  for (const problem of problems) console.error('verify-patch-manifest: ' + problem)
  console.error('verify-patch-manifest: ' + String(problems.length) + ' problem(s)')
  process.exit(1)
}
console.log(
  'verify-patch-manifest: ' + String(declared.length) + ' declared package(s) match patches/npm, ' +
  String(sourcePatches) + ' source patch(es) anchored to ' + sourceBase.slice(0, 12),
)
