/** Materialize the Plus distribution's independent patch packages without Desktop. */

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { satisfies, valid, validRange } from 'semver'
import { parseDocument } from 'yaml'

const FORMAT_VERSION = 1

interface InstalledPackage {
  name: string
  version: string
  directory: string
  manifest: Record<string, unknown>
}

interface RuntimePackage {
  name: string
  version: string
}

interface NpmTarget {
  kind: 'npm'
  name: string
  range: string
}

interface SourceTarget {
  kind: 'dsh-source'
  baseRevision: string
}

interface ParsedVariant {
  id: string
  dsh: string
  file: string
  patchPackage: InstalledPackage
  target: NpmTarget | SourceTarget
}

interface SelectedNpmPatch {
  id: string
  patchPackage: { name: string; version: string }
  file: string
  absoluteFile: string
  target: { kind: 'npm'; name: string; version: string }
}

interface SelectedSourcePatch {
  id: string
  patchPackage: { name: string; version: string }
  file: string
  absoluteFile: string
  target: { kind: 'dsh-source'; baseRevision: string }
  alreadyApplied: boolean
}

type SelectedPatch = SelectedNpmPatch | SelectedSourcePatch

function readJsonObject(path: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(label + ' must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object')
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(label + ' must be a non-empty string')
  return value
}

function requireRange(value: unknown, label: string): string {
  const range = requireString(value, label)
  if (validRange(range) === null) throw new Error(label + ' is not a semantic-version range: ' + range)
  return range
}

function requireVersion(value: unknown, label: string): string {
  const version = requireString(value, label)
  if (valid(version) === null) throw new Error(label + ' is not a semantic version: ' + version)
  return version
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(label + ' must be a non-empty array')
  const strings = value.map((entry, index) => requireString(entry, label + '[' + String(index) + ']'))
  if (new Set(strings).size !== strings.length) throw new Error(label + ' must not contain duplicates')
  return strings
}

function resolveInstalledPackage(distributionDirectory: string, packageName: string): InstalledPackage {
  const requireFromDistribution = createRequire(resolve(distributionDirectory, 'package.json'))
  const manifestPath = requireFromDistribution.resolve(packageName + '/package.json')
  const manifest = readJsonObject(manifestPath, packageName + ' manifest')
  return {
    name: packageName,
    version: requireVersion(manifest.version, packageName + ' version'),
    directory: dirname(manifestPath),
    manifest,
  }
}

function resolvePatchFile(packageDirectory: string, declared: string): { relativeFile: string; absoluteFile: string } {
  const absoluteFile = resolve(packageDirectory, declared)
  const local = relative(packageDirectory, absoluteFile)
  if (isAbsolute(local) || local === '..' || local.startsWith('../')) {
    throw new Error('patch file must stay inside its patch package: ' + declared)
  }
  if (!existsSync(absoluteFile)) throw new Error('patch file does not exist: ' + absoluteFile)
  return { relativeFile: local.replaceAll('\\', '/'), absoluteFile }
}

function parseVariant(value: unknown, index: number, patchPackage: InstalledPackage): ParsedVariant {
  const label = patchPackage.name + ' dshPatch.variants[' + String(index) + ']'
  const variant = requireObject(value, label)
  const target = requireObject(variant.target, label + '.target')
  const kind = requireString(target.kind, label + '.target.kind')
  const common = {
    id: requireString(variant.id, label + '.id'),
    dsh: requireRange(variant.dsh, label + '.dsh'),
    file: requireString(variant.file, label + '.file'),
    patchPackage,
  }
  if (kind === 'npm') {
    return {
      ...common,
      target: {
        kind,
        name: requireString(target.name, label + '.target.name'),
        range: requireRange(target.range, label + '.target.range'),
      },
    }
  }
  if (kind === 'dsh-source') {
    return {
      ...common,
      target: {
        kind,
        baseRevision: requireString(target.baseRevision, label + '.target.baseRevision'),
      },
    }
  }
  throw new Error('unsupported patch target kind: ' + kind)
}

function git(root: string, args: readonly string[], acceptFailure = false): string | undefined {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status === 0) return result.stdout.trim()
  if (acceptFailure) return undefined
  const detail = result.stderr.trim()
  throw new Error('git ' + args.join(' ') + ' failed' + (detail === '' ? '' : ': ' + detail))
}

function sourcePatchState(root: string, file: string): 'pending' | 'applied' {
  if (git(root, ['apply', '--check', file], true) !== undefined) return 'pending'
  if (git(root, ['apply', '--reverse', '--check', file], true) !== undefined) return 'applied'
  git(root, ['apply', '--check', file])
  throw new Error('unreachable')
}

function requireSourceBase(root: string, baseRevision: string): string {
  const checkoutRevision = requireString(git(root, ['rev-parse', 'HEAD']), 'DSH checkout revision')
  if (checkoutRevision !== baseRevision) {
    throw new Error('DSH checkout must be exact official base ' + baseRevision + ', found ' + checkoutRevision)
  }
  return checkoutRevision
}

function patchPackageVariants(distributionDirectory: string, names: readonly string[]): ParsedVariant[] {
  const variants: ParsedVariant[] = []
  for (const name of names) {
    const patchPackage = resolveInstalledPackage(distributionDirectory, name)
    const declaration = requireObject(patchPackage.manifest.dshPatch, name + ' dshPatch')
    if (declaration.formatVersion !== FORMAT_VERSION) {
      throw new Error('unsupported dshPatch formatVersion in ' + name + ': ' + String(declaration.formatVersion))
    }
    if (!Array.isArray(declaration.variants) || declaration.variants.length === 0) {
      throw new Error(name + ' dshPatch.variants must be a non-empty array')
    }
    for (const [index, value] of declaration.variants.entries()) {
      variants.push(parseVariant(value, index, patchPackage))
    }
  }
  return variants
}

// 先验证official source，再物化Plus声明的profile依赖，避免source不匹配时改动用户profile。
function prepareSelection(
  distributionDirectory: string,
  profileDirectory: string,
  dshRoot: string,
): {
  lock: Record<string, unknown>
  patches: SelectedPatch[]
  bundles: string[]
  runtimePackages: RuntimePackage[]
  profileDependencies: RuntimePackage[]
  allowBuilds: Record<string, boolean>
} {
  const distributionManifest = readJsonObject(resolve(distributionDirectory, 'package.json'), 'Plus distribution manifest')
  const distributionName = requireString(distributionManifest.name, 'Plus distribution name')
  const distributionVersion = requireVersion(distributionManifest.version, 'Plus distribution version')
  const plus = requireObject(distributionManifest.dshPlus, 'Plus distribution dshPlus')
  if (plus.formatVersion !== FORMAT_VERSION) {
    throw new Error('unsupported dshPlus formatVersion: ' + String(plus.formatVersion))
  }
  const compatibility = requireObject(plus.compatibility, 'dshPlus.compatibility')
  const dshRange = requireRange(compatibility.dsh, 'dshPlus.compatibility.dsh')
  const sourceBase = requireObject(plus.sourceBase, 'dshPlus.sourceBase')
  const baseRevision = requireString(sourceBase.revision, 'dshPlus.sourceBase.revision')
  const profile = requireObject(plus.profile, 'dshPlus.profile')
  const bundles = requireStringArray(profile.bundles, 'dshPlus.profile.bundles')
  const rawProfileDependencySpecs = requireObject(profile.dependencies, 'dshPlus.profile.dependencies')
  const profileDependencySpecs: Record<string, string> = {}
  for (const [name, spec] of Object.entries(rawProfileDependencySpecs)) {
    profileDependencySpecs[name] = requireString(spec, 'dshPlus.profile.dependencies.' + name)
  }
  const rawAllowBuilds = requireObject(profile.allowBuilds, 'dshPlus.profile.allowBuilds')
  const allowBuilds: Record<string, boolean> = {}
  for (const [name, allowed] of Object.entries(rawAllowBuilds)) {
    if (typeof allowed !== 'boolean') throw new Error('dshPlus.profile.allowBuilds.' + name + ' must be a boolean')
    allowBuilds[name] = allowed
  }
  const patchPackageNames = requireStringArray(plus.patchPackages, 'dshPlus.patchPackages')
  const dependencies = requireObject(distributionManifest.dependencies, 'Plus distribution dependencies')
  const dshManifest = readJsonObject(resolve(dshRoot, 'package.json'), 'DSH source manifest')
  const dshVersion = requireVersion(dshManifest.version, 'DSH source version')
  if (!satisfies(dshVersion, dshRange, { includePrerelease: true })) {
    throw new Error(distributionName + '@' + distributionVersion + ' requires DSH ' + dshRange + ', found ' + dshVersion)
  }
  const checkoutRevision = requireSourceBase(dshRoot, baseRevision)
  const groups = new Map<string, ParsedVariant[]>()
  for (const variant of patchPackageVariants(distributionDirectory, patchPackageNames)) {
    const entries = groups.get(variant.id) ?? []
    entries.push(variant)
    groups.set(variant.id, entries)
  }

  const sourceStates = new Map<string, ReturnType<typeof sourcePatchState>>()
  for (const variant of [...groups.values()].flat()) {
    if (variant.target.kind !== 'dsh-source'
      || variant.target.baseRevision !== baseRevision
      || !satisfies(dshVersion, variant.dsh, { includePrerelease: true })) continue
    const file = resolvePatchFile(variant.patchPackage.directory, variant.file)
    sourceStates.set(file.absoluteFile, sourcePatchState(dshRoot, file.absoluteFile))
  }
  const pendingSourceFiles = [...sourceStates].flatMap(([file, state]) => state === 'pending' ? [file] : [])
  if (pendingSourceFiles.length > 0) git(dshRoot, ['apply', '--check', ...pendingSourceFiles])

  if (writeProfileRequirements(profileDirectory, profileDependencySpecs, allowBuilds)) {
    runPnpm(profileDirectory, ['install'], 'pnpm install Plus profile dependencies')
  }
  const profileDependencies = Object.keys(profileDependencySpecs).sort().map((name) => {
    const installed = resolveInstalledPackage(profileDirectory, name)
    return { name, version: installed.version }
  })
  const runtimePackages = [
    ...Object.keys(dependencies).filter(name => !patchPackageNames.includes(name)).sort().map((name) => {
      const installed = resolveInstalledPackage(distributionDirectory, name)
      return { name, version: installed.version }
    }),
    ...profileDependencies,
  ].sort((left, right) => left.name.localeCompare(right.name))

  const selected: SelectedPatch[] = []
  // 每个patch id必须在当前DSH、official base与installed npm graph上唯一命中，不能fallback到第二variant。
  for (const id of [...groups.keys()].sort()) {
    const candidates = (groups.get(id) ?? []).flatMap((variant): SelectedPatch[] => {
      if (!satisfies(dshVersion, variant.dsh, { includePrerelease: true })) return []
      const file = resolvePatchFile(variant.patchPackage.directory, variant.file)
      if (variant.target.kind === 'dsh-source') {
        if (variant.target.baseRevision !== baseRevision) return []
        return [{
          id,
          patchPackage: { name: variant.patchPackage.name, version: variant.patchPackage.version },
          file: file.relativeFile,
          absoluteFile: file.absoluteFile,
          target: { kind: 'dsh-source', baseRevision },
          alreadyApplied: sourceStates.get(file.absoluteFile) === 'applied',
        }]
      }
      const targetDirectory = variant.target.name in profileDependencySpecs ? profileDirectory : distributionDirectory
      const targetVersion = resolveInstalledPackage(targetDirectory, variant.target.name).version
      if (!satisfies(targetVersion, variant.target.range, { includePrerelease: true })) return []
      return [{
        id,
        patchPackage: { name: variant.patchPackage.name, version: variant.patchPackage.version },
        file: file.relativeFile,
        absoluteFile: file.absoluteFile,
        target: { kind: 'npm', name: variant.target.name, version: targetVersion },
      }]
    })
    const [candidate] = candidates
    if (candidate === undefined) throw new Error('no compatible patch variant for ' + id + ' on DSH ' + dshVersion)
    if (candidates.length > 1) throw new Error('multiple compatible patch variants for ' + id + ' on DSH ' + dshVersion)
    selected.push(candidate)
  }

  const lockPatches = selected.map((patch) => {
    if ('alreadyApplied' in patch) {
      const { absoluteFile: _absoluteFile, alreadyApplied: _alreadyApplied, ...locked } = patch
      return locked
    }
    const { absoluteFile: _absoluteFile, ...locked } = patch
    return locked
  })
  return {
    patches: selected,
    bundles,
    runtimePackages,
    profileDependencies,
    allowBuilds,
    lock: {
      formatVersion: FORMAT_VERSION,
      distribution: { name: distributionName, version: distributionVersion },
      dsh: { version: dshVersion, baseRevision, checkoutRevision },
      runtimePackages,
      patches: lockPatches,
    },
  }
}

function materializePatchFiles(profileDirectory: string, patches: readonly SelectedPatch[]): SelectedPatch[] {
  const root = resolve(profileDirectory, '.dsh-plus', 'patches')
  rmSync(root, { recursive: true, force: true })
  return patches.map((patch) => {
    const destination = resolve(root, patch.patchPackage.name, patch.patchPackage.version, patch.file)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(patch.absoluteFile, destination)
    return { ...patch, absoluteFile: destination }
  })
}

function profilePatchConfiguration(profileDirectory: string, patches: readonly SelectedPatch[]): { text: string; changed: boolean } {
  const path = resolve(profileDirectory, 'pnpm-workspace.yaml')
  const document = parseDocument(readFileSync(path, 'utf8'))
  const [documentError] = document.errors
  if (documentError !== undefined) throw new Error('Plus profile workspace is not valid YAML', { cause: documentError })
  let changed = false
  const desiredKeys = new Set(patches.flatMap(patch => patch.target.kind === 'npm'
    ? [patch.target.name + '@' + patch.target.version]
    : []))
  const workspace = requireObject(document.toJS() as unknown, 'Plus profile workspace')
  const configured = workspace.patchedDependencies === undefined
    ? {}
    : requireObject(workspace.patchedDependencies, 'Plus profile patchedDependencies')
  for (const [key, value] of Object.entries(configured)) {
    if (typeof value === 'string' && value.startsWith('.dsh-plus/patches/') && !desiredKeys.has(key)) {
      document.deleteIn(['patchedDependencies', key])
      changed = true
    }
  }
  for (const patch of patches) {
    if (patch.target.kind !== 'npm') continue
    const key = patch.target.name + '@' + patch.target.version
    const value = relative(profileDirectory, patch.absoluteFile).replaceAll('\\', '/')
    const current = document.getIn(['patchedDependencies', key])
    if (current !== undefined && current !== value
      && (typeof current !== 'string' || !current.startsWith('.dsh-plus/patches/'))) {
      throw new Error('profile patchedDependencies.' + key + ' is already owned by another payload')
    }
    if (current === value) continue
    document.setIn(['patchedDependencies', key], value)
    changed = true
  }
  return { text: String(document), changed }
}

// 用户显式执行apply后，这里一次性写入profile root依赖与唯一native build许可；冲突直接失败。
function writeProfileRequirements(
  profileDirectory: string,
  dependencySpecs: Readonly<Record<string, string>>,
  allowBuilds: Readonly<Record<string, boolean>>,
): boolean {
  const manifestPath = resolve(profileDirectory, 'package.json')
  const manifest = readJsonObject(manifestPath, 'DSH profile manifest')
  const dependencies = requireObject(manifest.dependencies, 'DSH profile dependencies')
  let manifestChanged = false
  for (const [name, spec] of Object.entries(dependencySpecs)) {
    const current = dependencies[name]
    if (current !== undefined && current !== spec) {
      throw new Error('profile dependency ' + name + ' is configured as ' + JSON.stringify(current) + ', expected ' + spec)
    }
    if (current === undefined) {
      dependencies[name] = spec
      manifestChanged = true
    }
  }
  const workspacePath = resolve(profileDirectory, 'pnpm-workspace.yaml')
  const document = parseDocument(readFileSync(workspacePath, 'utf8'))
  const [documentError] = document.errors
  if (documentError !== undefined) throw new Error('Plus profile workspace is not valid YAML', { cause: documentError })
  let workspaceChanged = false
  for (const [name, allowed] of Object.entries(allowBuilds)) {
    const current = document.getIn(['allowBuilds', name])
    if (current !== undefined && current !== allowed) {
      throw new Error('profile allowBuilds.' + name + ' is configured as ' + JSON.stringify(current) + ', expected ' + String(allowed))
    }
    if (current === undefined) {
      document.setIn(['allowBuilds', name], allowed)
      workspaceChanged = true
    }
  }
  if (manifestChanged) {
    manifest.dependencies = dependencies
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  }
  if (workspaceChanged) writeFileSync(workspacePath, String(document))
  return manifestChanged || workspaceChanged
}

function writeProfileComposition(
  profileDirectory: string,
  bundles: readonly string[],
  runtimePackages: readonly RuntimePackage[],
): boolean {
  const path = resolve(profileDirectory, 'package.json')
  const manifest = readJsonObject(path, 'DSH profile manifest')
  const dependencies = requireObject(manifest.dependencies, 'DSH profile dependencies')
  let changed = false
  for (const runtimePackage of runtimePackages) {
    const current = dependencies[runtimePackage.name]
    if (current === undefined) {
      dependencies[runtimePackage.name] = runtimePackage.version
      changed = true
      continue
    }
    const installed = resolveInstalledPackage(profileDirectory, runtimePackage.name)
    if (installed.version !== runtimePackage.version) {
      throw new Error(
        'profile dependency ' + runtimePackage.name + ' resolves to ' + installed.version
        + ', but the Plus distribution requires ' + runtimePackage.version,
      )
    }
  }
  const dsh = manifest.dsh === undefined ? {} : requireObject(manifest.dsh, 'DSH profile dsh')
  const profile = dsh.profile === undefined ? {} : requireObject(dsh.profile, 'DSH profile dsh.profile')
  if (JSON.stringify(profile.bundles) !== JSON.stringify(bundles)) changed = true
  manifest.dependencies = dependencies
  manifest.dsh = { ...dsh, profile: { ...profile, bundles: [...bundles] } }
  if (changed) writeFileSync(path, JSON.stringify(manifest, undefined, 2) + '\n')
  return changed
}

function runPnpm(profileDirectory: string, args: readonly string[], label: string): void {
  const result = spawnSync('pnpm', args, { cwd: profileDirectory, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(label + ' failed with exit code ' + String(result.status))
}

function pendingSourcePatchFiles(patches: readonly SelectedPatch[]): string[] {
  return patches.flatMap(patch => 'alreadyApplied' in patch && !patch.alreadyApplied
    ? [patch.absoluteFile]
    : [])
}

function applySelectedPatches(
  profileDirectory: string,
  dshRoot: string,
  patches: readonly SelectedPatch[],
  profileChanged: boolean,
): void {
  const stablePatches = materializePatchFiles(profileDirectory, patches)
  const workspacePath = resolve(profileDirectory, 'pnpm-workspace.yaml')
  const workspace = profilePatchConfiguration(profileDirectory, stablePatches)
  if (workspace.changed) writeFileSync(workspacePath, workspace.text)
  if (profileChanged || workspace.changed) {
    runPnpm(profileDirectory, ['install'], 'pnpm install in Plus profile')
  }
  const sourceFiles = pendingSourcePatchFiles(stablePatches)
  if (sourceFiles.length > 0) git(dshRoot, ['apply', ...sourceFiles])
  if (stablePatches.some(patch => patch.target.kind === 'dsh-source')) {
    runPnpm(dshRoot, ['run', 'build'], 'official DSH build after source patches')
  }
}

// Profile plugins通过exact source checkout解析official peers；npm profile不复制该scope。
function linkOfficialPackages(profileDirectory: string, dshRoot: string): void {
  const source = resolve(dshRoot, 'node_modules', '@deepseek-ai')
  if (!existsSync(source)) throw new Error('official DSH dependencies are missing under ' + source)
  const destination = resolve(profileDirectory, 'node_modules', '@deepseek-ai')
  rmSync(destination, { recursive: true, force: true })
  symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
}

function writeLock(profileDirectory: string, lock: Record<string, unknown>): string {
  const directory = resolve(profileDirectory, '.dsh-plus')
  mkdirSync(directory, { recursive: true })
  const path = resolve(directory, 'patchset.lock.json')
  writeFileSync(path, JSON.stringify(lock, undefined, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

function parseApplyArguments(argv: readonly string[]): { dshRoot: string; profileDirectory: string } {
  if (argv[0] !== 'apply') throw new Error('usage: dsh-plus apply --dsh-root <official-dsh-root>')
  let dshRoot: string | undefined
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key !== '--dsh-root' || value === undefined) throw new Error('usage: dsh-plus apply --dsh-root <official-dsh-root>')
    dshRoot = resolve(value)
  }
  if (dshRoot === undefined) throw new Error('usage: dsh-plus apply --dsh-root <official-dsh-root>')
  return { dshRoot, profileDirectory: process.cwd() }
}

/**
 * Apply the installed Plus distribution metadata from a DSH profile directory.
 * @param argv - Explicit `apply --dsh-root <path>` command arguments.
 */
export function runApply(argv: readonly string[]): void {
  const { dshRoot, profileDirectory } = parseApplyArguments(argv)
  const profileManifest = readJsonObject(resolve(profileDirectory, 'package.json'), 'DSH profile manifest')
  const dependencies = requireObject(profileManifest.dependencies, 'DSH profile dependencies')
  if (dependencies['@sparkelf/dsh-plus'] === undefined) {
    throw new Error('current directory is not a DSH profile with @sparkelf/dsh-plus installed')
  }
  const distributionDirectory = dirname(createRequire(resolve(profileDirectory, 'package.json'))
    .resolve('@sparkelf/dsh-plus/package.json'))
  const selection = prepareSelection(distributionDirectory, profileDirectory, dshRoot)
  const profileChanged = writeProfileComposition(
    profileDirectory,
    selection.bundles,
    selection.runtimePackages,
  )
  applySelectedPatches(profileDirectory, dshRoot, selection.patches, profileChanged)
  linkOfficialPackages(profileDirectory, dshRoot)
  const installedProfileDependencies = requireObject(
    readJsonObject(resolve(profileDirectory, 'package.json'), 'DSH profile manifest').dependencies,
    'DSH profile dependencies',
  )
  selection.lock.profile = {
    bundles: selection.bundles.map((name) => {
      const installed = installedProfileDependencies[name] === undefined
        ? resolveInstalledPackage(dshRoot, name)
        : resolveInstalledPackage(profileDirectory, name)
      return { name, version: installed.version }
    }),
    dependencies: selection.profileDependencies,
    allowBuilds: selection.allowBuilds,
  }
  const lock = writeLock(profileDirectory, selection.lock)
  process.stdout.write('[dsh-plus] applied ' + String(selection.patches.length) + ' patches; lock ' + lock + '\n')
}
