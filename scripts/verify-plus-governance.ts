/** Verify Plus npm composition, independent patch packages, and curation ownership. */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { satisfies, valid, validRange } from 'semver'
import { parse } from 'yaml'
import { loadCordisYaml } from './cordis-yaml.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const distributionPath = 'packages/bundle/plus/package.json'
const patchRoot = 'patches/npm'
const requireFromDistribution = createRequire(resolve(root, distributionPath))

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object')
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(label + ' must be a non-empty string')
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(label + ' must be an array')
  return value
}

function packageNameFromSpecifier(specifier: string): string {
  const segments = specifier.split('/')
  if (specifier.startsWith('@')) {
    const scope = segments[0]
    const name = segments[1]
    if (scope === undefined || scope === '' || name === undefined || name === '') {
      throw new Error('invalid scoped package specifier: ' + specifier)
    }
    return scope + '/' + name
  }
  const name = segments[0]
  if (name === undefined || name === '') throw new Error('invalid package specifier: ' + specifier)
  return name
}

function json(path: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(resolve(root, path), 'utf8')) as unknown, path)
}

function minimumRange(value: unknown, label: string): string {
  const range = string(value, label)
  if (!/^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(range) || validRange(range) === null) {
    throw new Error(label + ' must be a minimum-only semantic-version range')
  }
  return range
}

function patchTargetRange(value: unknown, label: string): string {
  const range = string(value, label)
  const normalized = validRange(range)
  const bounded = normalized?.split('||').every(branch =>
    valid(branch.trim()) !== null || /(?:^|\s)<[=]?/.test(branch))
  if (normalized === null || !bounded) {
    throw new Error(label + ' must be an exact or upper-bounded semantic-version range')
  }
  return range
}

interface PatchRecord {
  name: string
  version: string
  directory: string
  targets: ({ kind: 'npm'; name: string; range: string } | { kind: 'dsh-source'; baseRevision: string; paths: string[] })[]
}

function sourcePatchPaths(path: string): string[] {
  const result = spawnSync('git', ['apply', '--numstat', path], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('cannot inspect source patch ' + path + ': ' + result.stderr.trim())
  return result.stdout.trim().split('\n').filter(Boolean).map(line => line.split('\t').at(-1) ?? '')
}

function verifySourcePatchApplies(path: string): void {
  const result = spawnSync('git', ['apply', '--check', path], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('source patch does not apply to the official base: ' + path + ': ' + result.stderr.trim())
}

/** npm payload必须能应用到distribution当前解析的exact target，不能把失败推迟到部署。 */
function verifyNpmPatchApplies(name: string, range: string, path: string): void {
  const manifestPath = requireFromDistribution.resolve(name + '/package.json')
  const manifest = json(manifestPath)
  const version = string(manifest.version, name + ' installed version')
  if (!satisfies(version, range, { includePrerelease: true })) {
    throw new Error(name + ' installed version ' + version + ' does not satisfy patch target ' + range)
  }
  const result = spawnSync('git', ['apply', '--check', path], { cwd: dirname(manifestPath), encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error('npm patch does not apply to ' + name + '@' + version + ': ' + path + ': ' + result.stderr.trim())
  }
}

function patchPackages(sourceBaseRevision: string): PatchRecord[] {
  const records: PatchRecord[] = []
  for (const entry of readdirSync(resolve(root, patchRoot), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = resolve(root, patchRoot, entry.name)
    const manifest = json(relative(root, resolve(directory, 'package.json')))
    const name = string(manifest.name, entry.name + ' name')
    const version = string(manifest.version, name + ' version')
    if (valid(version) === null) throw new Error(name + ' version is not semantic')
    if (JSON.stringify(manifest.files) !== JSON.stringify(['patches/*.patch'])) {
      throw new Error(name + ' must publish exactly ["patches/*.patch"]')
    }
    if (manifest.main !== undefined || manifest.scripts !== undefined || manifest.bin !== undefined) {
      throw new Error(name + ' must remain data-only')
    }
    const declaration = object(manifest.dshPatch, name + ' dshPatch')
    if (declaration.formatVersion !== 1) throw new Error(name + ' dshPatch.formatVersion must be 1')
    const targets: PatchRecord['targets'] = []
    const declaredPayloads = new Set<string>()
    for (const [index, raw] of array(declaration.variants, name + ' variants').entries()) {
      const variant = object(raw, name + ' variant ' + String(index))
      minimumRange(variant.dsh, name + ' variant dsh')
      string(variant.id, name + ' variant id')
      const declaredFile = string(variant.file, name + ' variant file')
      const payload = resolve(directory, declaredFile)
      const payloadPath = relative(resolve(directory, 'patches'), payload)
      if (!existsSync(payload) || isAbsolute(payloadPath) || payloadPath === '..' || payloadPath.startsWith('../')) {
        throw new Error(name + ' variant payload must exist under its patches directory')
      }
      declaredPayloads.add(relative(directory, payload).replaceAll('\\', '/'))
      const target = object(variant.target, name + ' variant target')
      const kind = string(target.kind, name + ' variant target kind')
      if (kind === 'npm') {
        const targetName = string(target.name, name + ' target name')
        const targetRange = patchTargetRange(target.range, name + ' target range')
        verifyNpmPatchApplies(targetName, targetRange, payload)
        targets.push({ kind, name: targetName, range: targetRange })
      } else if (kind === 'dsh-source') {
        const baseRevision = string(target.baseRevision, name + ' target baseRevision')
        if (baseRevision !== sourceBaseRevision) throw new Error(name + ' source target must match dshPlus.sourceBase.revision')
        const allowedPaths = array(target.paths, name + ' target paths').map((value, pathIndex) =>
          string(value, name + ' target paths[' + String(pathIndex) + ']'))
        if (allowedPaths.length === 0 || allowedPaths.some(path => !path.endsWith('/'))) {
          throw new Error(name + ' source target paths must be non-empty repository directory prefixes')
        }
        const paths = sourcePatchPaths(payload)
        if (paths.length === 0 || paths.some(path => !allowedPaths.some(prefix => path.startsWith(prefix)))) {
          throw new Error(name + ' source payload modifies a path outside its declared owners')
        }
        verifySourcePatchApplies(payload)
        targets.push({ kind, baseRevision, paths: allowedPaths })
      } else {
        throw new Error(name + ' has unsupported target kind ' + kind)
      }
    }
    if (targets.length === 0) throw new Error(name + ' must declare at least one variant')
    const publishedPayloads = readdirSync(resolve(directory, 'patches'))
      .filter(file => file.endsWith('.patch')).map(file => 'patches/' + file).sort()
    if (JSON.stringify([...declaredPayloads].sort()) !== JSON.stringify(publishedPayloads)) {
      throw new Error(name + ' must declare every published patch payload exactly once')
    }
    records.push({ name, version, directory, targets })
  }
  return records.sort((left, right) => left.name.localeCompare(right.name))
}

function main(): void {
  const distribution = json(distributionPath)
  const plus = object(distribution.dshPlus, 'dshPlus')
  if (plus.formatVersion !== 1) throw new Error('dshPlus.formatVersion must be 1')
  const sourceBase = object(plus.sourceBase, 'dshPlus.sourceBase')
  const sourceBaseRevision = string(sourceBase.revision, 'dshPlus.sourceBase.revision')
  if (!/^[0-9a-f]{40}$/.test(sourceBaseRevision)) throw new Error('dshPlus.sourceBase.revision must be a full git revision')
  const compatibility = object(plus.compatibility, 'dshPlus.compatibility')
  minimumRange(compatibility.dsh, 'dshPlus.compatibility.dsh')
  const dependencies = object(distribution.dependencies, 'distribution dependencies')
  for (const [name, range] of Object.entries(dependencies)) minimumRange(range, 'distribution dependencies.' + name)
  const profile = object(plus.profile, 'dshPlus.profile')
  const bundles = array(profile.bundles, 'dshPlus.profile.bundles').map((value, index) =>
    string(value, 'dshPlus.profile.bundles[' + String(index) + ']'))
  if (new Set(bundles).size !== bundles.length) throw new Error('dshPlus.profile.bundles must not contain duplicates')
  const profileDependencies = object(profile.dependencies, 'dshPlus.profile.dependencies')
  const expectedProfileDependencies = {
    'dsh-better-sidebar': '0.17.1',
    '@huanlin/dsh-plugin-better-sidebar-plugin-office': '0.1.2',
    'dsh-video-preview': '0.1.4',
    'dsh-univer-office': '0.2.12',
    '@sparkelf/dsh-plugin-supervisor': '0.1.1',
  }
  if (JSON.stringify(profileDependencies) !== JSON.stringify(expectedProfileDependencies)) {
    throw new Error('dshPlus.profile.dependencies must own the exact external preview, Office, and Supervisor bundle set')
  }
  const allowBuilds = object(profile.allowBuilds, 'dshPlus.profile.allowBuilds')
  if (JSON.stringify(allowBuilds) !== JSON.stringify({ 'node-pty': true, protobufjs: false })) {
    throw new Error('dshPlus.profile.allowBuilds must allow node-pty and explicitly deny protobufjs')
  }
  // External runtime packages由transitive dependency或apply-owned profile dependency恰好一个owner提供。
  for (const name of Object.keys(profileDependencies)) {
    if (dependencies[name] !== undefined) throw new Error(name + ' must not have two dependency owners')
  }
  const ownsRuntimePackage = (name: string): boolean =>
    dependencies[name] !== undefined || profileDependencies[name] !== undefined
  for (const bundle of bundles) {
    if (bundle.startsWith('@deepseek-ai/') || bundle === distribution.name) continue
    if (!ownsRuntimePackage(bundle)) throw new Error('distribution must own external profile bundle ' + bundle)
  }
  const declaredPatchPackages = array(plus.patchPackages, 'dshPlus.patchPackages').map((value, index) =>
    string(value, 'dshPlus.patchPackages[' + String(index) + ']')).sort()
  const records = patchPackages(sourceBaseRevision)
  const sourcePatchPackages = records.map(record => record.name)
  if (JSON.stringify(declaredPatchPackages) !== JSON.stringify(sourcePatchPackages)) {
    throw new Error('dshPlus.patchPackages must reference every source patch package exactly once')
  }
  for (const record of records) {
    if (dependencies[record.name] === undefined) throw new Error('distribution must depend on ' + record.name)
    for (const target of record.targets) {
      if (target.kind === 'npm' && !ownsRuntimePackage(target.name)) {
        throw new Error('distribution must own patched npm target ' + target.name)
      }
    }
  }
  const patch = loadCordisYaml(readFileSync(resolve(root, 'packages/bundle/plus/cordis.patch.yml'), 'utf8'))
  const rows = array(patch, 'Plus Cordis patch').flatMap((operation) => {
    const insert = object(operation, 'Plus Cordis operation').insert
    return insert === undefined ? [] : array(insert, 'Plus Cordis insert')
  })
  for (const raw of rows) {
    const row = object(raw, 'Plus Cordis row')
    const name = string(row.name, 'Plus Cordis row name')
    const packageName = packageNameFromSpecifier(name)
    if (!ownsRuntimePackage(packageName)) throw new Error('distribution must own Cordis row package ' + packageName)
  }
  const curation = object(parse(readFileSync(resolve(root, '.agents/plugins/curated.yaml'), 'utf8')) as unknown, 'curation')
  const curatedPackages = array(curation.entries, 'curation entries').flatMap(raw =>
    array(object(raw, 'curation entry').localPatches, 'curation localPatches')
      .map(patch => string(object(patch, 'curation patch').package, 'curation patch package'))).sort()
  if (JSON.stringify(curatedPackages) !== JSON.stringify(sourcePatchPackages)) {
    throw new Error('curation must own upstream retirement for every source patch package exactly once')
  }
  console.info('verify-plus-governance: profile composition, patch packages, source base, and curation are consistent.')
}

main()
