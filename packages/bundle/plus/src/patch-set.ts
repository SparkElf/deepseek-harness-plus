/**
 * Read the Plus distribution's embedded patch set.
 *
 * The distribution owns one patch set for official DSH and, separately, the patches it
 * carries for third-party packages. Both live inside the distribution package: the
 * manifest declares entries, and each entry's payload is a file under `patches/`. A
 * consumer resolves no independently published patch package.
 *
 * The two lists are governed differently. A Plus entry must target an official package
 * that the profile republishes and overrides; a third-party entry must name its upstream
 * and a retirement condition, and never becomes part of the official patch set.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { validRange } from 'semver'

/** An npm package the distribution patches in place. */
export interface NpmPatchTarget {
  readonly kind: 'npm'
  readonly name: string
  readonly range: string
}

/** One official source path set, applied to the exact `dshPlus.sourceBase` revision. */
export interface SourcePatchTarget {
  readonly kind: 'dsh-source'
  readonly baseRevision: string
  /** Official packages the patch modifies; each must be republished and overridden. */
  readonly packages: readonly string[]
  readonly paths: readonly string[]
}

/** Where one patch payload lands. */
export type PatchTarget = NpmPatchTarget | SourcePatchTarget

/** Who owns the entry: the Plus official delta or a carried third-party patch. */
export type PatchScope = 'plus' | 'third-party'

/** One entry of the embedded patch set. */
export interface PatchSetEntry {
  /** Stable identity used by the lock and by retirement records. */
  readonly id: string
  readonly scope: PatchScope
  /** DSH range the entry applies to. */
  readonly dsh: string
  /** Payload path, relative to the distribution package. */
  readonly file: string
  /** The behavior or upstream release that retires this entry. */
  readonly retireWhen: string
  /** Third-party entries name the upstream they track. */
  readonly upstreamUrl?: string
  readonly target: PatchTarget
}

/** The distribution's complete embedded patch declaration. */
export interface PatchSet {
  readonly entries: readonly PatchSetEntry[]
  readonly thirdPartyPatches: readonly PatchSetEntry[]
  readonly sourceBaseRevision: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object')
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(label + ' must be a non-empty string')
  return value
}

function range(value: unknown, label: string): string {
  const text = string(value, label)
  if (validRange(text) === null) throw new Error(label + ' is not a semantic-version range: ' + text)
  return text
}

/** A payload stays inside the distribution package it is declared by. */
function patchFile(distributionDirectory: string, declared: string, label: string): string {
  const absolute = resolve(distributionDirectory, declared)
  const local = relative(distributionDirectory, absolute)
  if (local === '' || isAbsolute(local) || local === '..' || local.startsWith('../')) {
    throw new Error(label + ' must stay inside the distribution package: ' + declared)
  }
  if (!existsSync(absolute)) throw new Error(label + ' does not exist: ' + absolute)
  return local.replaceAll('\\', '/')
}

function sourceTarget(value: unknown, sourceBaseRevision: string, label: string): SourcePatchTarget {
  const target = object(value, label)
  if (target.kind !== 'dsh-source') throw new Error(label + '.kind must be dsh-source')
  if (!Array.isArray(target.paths) || target.paths.length === 0) throw new Error(label + '.paths must be a non-empty array')
  const paths = target.paths.map((entry, index) => {
    const path = string(entry, label + '.paths[' + String(index) + ']')
    if (!path.endsWith('/')) throw new Error(label + '.paths entries must be repository directory prefixes')
    return path
  })
  if (!Array.isArray(target.packages) || target.packages.length === 0) {
    throw new Error(label + '.packages must be a non-empty array')
  }
  const packages = target.packages.map((entry, index) => {
    const name = string(entry, label + '.packages[' + String(index) + ']')
    if (!name.startsWith('@deepseek-ai/')) throw new Error(label + '.packages entries must be official package names')
    return name
  })
  return { kind: 'dsh-source', baseRevision: sourceBaseRevision, packages, paths }
}

function npmTarget(value: unknown, label: string): NpmPatchTarget {
  const target = object(value, label)
  if (target.kind !== 'npm') throw new Error(label + '.kind must be npm')
  return {
    kind: 'npm',
    name: string(target.name, label + '.name'),
    range: range(target.range, label + '.range'),
  }
}

function entry(
  value: unknown,
  scope: PatchScope,
  sourceBaseRevision: string,
  distributionDirectory: string,
  label: string,
): PatchSetEntry {
  const record = object(value, label)
  const id = string(record.id, label + '.id')
  const dsh = range(record.dsh, label + '.dsh')
  const file = patchFile(distributionDirectory, string(record.file, label + '.file'), label + '.file')
  const retireWhen = string(record.retireWhen, label + '.retireWhen')
  const targetLabel = label + '.target'
  const target = scope === 'plus'
    ? (object(record.target, targetLabel).kind === 'dsh-source'
      ? sourceTarget(record.target, sourceBaseRevision, targetLabel)
      : npmTarget(record.target, targetLabel))
    : npmTarget(record.target, targetLabel)
  if (scope === 'third-party') {
    return {
      id,
      scope,
      dsh,
      file,
      retireWhen,
      upstreamUrl: string(record.upstreamUrl, label + '.upstreamUrl'),
      target,
    }
  }
  return { id, scope, dsh, file, retireWhen, target }
}

/**
 * Read and validate the embedded patch set from an installed distribution.
 * @param distributionDirectory - installed `@sparkelf/dsh-plus` directory.
 * @param manifest - its parsed package manifest.
 * @returns the ordered Plus entries, third-party entries, and the exact source base.
 */
export function readPatchSet(
  distributionDirectory: string,
  manifest: Record<string, unknown>,
): PatchSet {
  const plus = object(manifest.dshPlus, 'dshPlus')
  const sourceBase = object(plus.sourceBase, 'dshPlus.sourceBase')
  const sourceBaseRevision = string(sourceBase.revision, 'dshPlus.sourceBase.revision')
  const declaration = object(plus.patchSet, 'dshPlus.patchSet')
  if (declaration.formatVersion !== 1) throw new Error('dshPlus.patchSet.formatVersion must be 1')
  if (!Array.isArray(declaration.entries) || declaration.entries.length === 0) {
    throw new Error('dshPlus.patchSet.entries must be a non-empty array')
  }
  const entries = declaration.entries.map((value, index) =>
    entry(value, 'plus', sourceBaseRevision, distributionDirectory, 'dshPlus.patchSet.entries[' + String(index) + ']'))
  const thirdPartyRaw = plus.thirdPartyPatches
  const thirdParty = thirdPartyRaw === undefined
    ? []
    : (Array.isArray(thirdPartyRaw)
      ? thirdPartyRaw.map((value, index) =>
        entry(value, 'third-party', sourceBaseRevision, distributionDirectory, 'dshPlus.thirdPartyPatches[' + String(index) + ']'))
      : (() => { throw new Error('dshPlus.thirdPartyPatches must be an array') })())
  const ids = new Set<string>()
  for (const item of [...entries, ...thirdParty]) {
    if (ids.has(item.id)) throw new Error('duplicate patch entry id: ' + item.id)
    ids.add(item.id)
  }
  return { entries, thirdPartyPatches: thirdParty, sourceBaseRevision }
}
