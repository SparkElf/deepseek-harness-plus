/** Materialize the Plus distribution's independent patch packages without Desktop. */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
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

/** One official workspace package available as a profile peer dependency. */
export interface OfficialWorkspacePackage {
  name: string
  directory: string
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

function isSelectedNpmPatch(patch: SelectedPatch): patch is SelectedNpmPatch {
  return patch.target.kind === 'npm'
}

interface MaterializedPatches {
  patches: readonly SelectedPatch[]
  npmPatchFiles: ReadonlyMap<string, string>
}

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

/** 在隔离index中按真实顺序预演source patches，避免失败后污染official worktree。 */
function preflightSourcePatches(root: string, files: readonly string[]): void {
  if (files.length === 0) return
  const directory = mkdtempSync(resolve(tmpdir(), 'dsh-plus-source-patches-'))
  const index = resolve(directory, 'index')
  const env = { ...process.env, GIT_INDEX_FILE: index }
  const run = (args: readonly string[]): void => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env })
    if (result.status === 0) return
    const detail = result.stderr.trim()
    throw new Error('git ' + args.join(' ') + ' failed' + (detail === '' ? '' : ': ' + detail))
  }
  try {
    run(['read-tree', 'HEAD'])
    for (const file of files) run(['apply', '--cached', '--3way', file])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
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
  const orderedGroups = [...groups].sort(([left], [right]) => left.localeCompare(right))
  for (const [, variants] of orderedGroups) {
    for (const variant of variants) {
      if (variant.target.kind !== 'dsh-source'
        || variant.target.baseRevision !== baseRevision
        || !satisfies(dshVersion, variant.dsh, { includePrerelease: true })) continue
      const file = resolvePatchFile(variant.patchPackage.directory, variant.file)
      sourceStates.set(file.absoluteFile, sourcePatchState(dshRoot, file.absoluteFile))
    }
  }
  const pendingSourceFiles = [...sourceStates].flatMap(([file, state]) => state === 'pending' ? [file] : [])
  preflightSourcePatches(dshRoot, pendingSourceFiles)

  if (writeProfileRequirements(profileDirectory, profileDependencySpecs, allowBuilds)) {
    runPnpm(profileDirectory, ['install', '--no-frozen-lockfile'], 'pnpm install Plus profile dependencies')
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
  for (const [id, variants] of orderedGroups) {
    const candidates = variants.flatMap((variant): SelectedPatch[] => {
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

/** 保留每个独立payload，并为同一npm目标生成pnpm可消费的唯一组合patch。 */
function materializePatchFiles(profileDirectory: string, patches: readonly SelectedPatch[]): MaterializedPatches {
  const root = resolve(profileDirectory, '.dsh-plus', 'patches')
  rmSync(root, { recursive: true, force: true })
  const stablePatches = patches.map((patch) => {
    const destination = resolve(root, patch.patchPackage.name, patch.patchPackage.version, patch.file)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(patch.absoluteFile, destination)
    return { ...patch, absoluteFile: destination }
  })
  const npmGroups = new Map<string, [SelectedNpmPatch, ...SelectedNpmPatch[]]>()
  for (const patch of stablePatches) {
    if (!isSelectedNpmPatch(patch)) continue
    const key = patch.target.name + '@' + patch.target.version
    const group = npmGroups.get(key)
    if (group === undefined) npmGroups.set(key, [patch])
    else group.push(patch)
  }
  const npmPatchFiles = new Map<string, string>()
  for (const [key, group] of npmGroups) {
    const first = group[0]
    if (group.length === 1) {
      npmPatchFiles.set(key, first.absoluteFile)
      continue
    }
    // 成员或版本变化必须改变workspace路径，使pnpm重新应用新的组合payload。
    const members = group.map(patch => encodeURIComponent(patch.id + '@' + patch.patchPackage.version)).join('+')
    const destination = resolve(root, 'combined', encodeURIComponent(key), members + '.patch')
    mkdirSync(dirname(destination), { recursive: true })
    const contents = group.map((patch) => {
      const content = readFileSync(patch.absoluteFile, 'utf8')
      return content.endsWith('\n') ? content : content + '\n'
    }).join('')
    writeFileSync(destination, contents)
    npmPatchFiles.set(key, destination)
  }
  return { patches: stablePatches, npmPatchFiles }
}

function profilePatchConfiguration(
  profileDirectory: string,
  npmPatchFiles: ReadonlyMap<string, string>,
): { text: string; changed: boolean } {
  const path = resolve(profileDirectory, 'pnpm-workspace.yaml')
  const document = parseDocument(readFileSync(path, 'utf8'))
  const [documentError] = document.errors
  if (documentError !== undefined) throw new Error('Plus profile workspace is not valid YAML', { cause: documentError })
  let changed = false
  const desiredKeys = new Set(npmPatchFiles.keys())
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
  for (const [key, file] of npmPatchFiles) {
    const value = relative(profileDirectory, file).replaceAll('\\', '/')
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
  const materialized = materializePatchFiles(profileDirectory, patches)
  const workspacePath = resolve(profileDirectory, 'pnpm-workspace.yaml')
  const workspace = profilePatchConfiguration(profileDirectory, materialized.npmPatchFiles)
  if (workspace.changed) writeFileSync(workspacePath, workspace.text)
  if (profileChanged || workspace.changed) {
    runPnpm(profileDirectory, ['install', '--no-frozen-lockfile'], 'pnpm install in Plus profile')
  }
  const sourceFiles = pendingSourcePatchFiles(materialized.patches)
  // Docker/overlay copy会使内容未变的文件stat失效；先刷新clean index项，脏文件仍由git apply判冲突。
  if (sourceFiles.length > 0) git(dshRoot, ['update-index', '--refresh'], true)
  for (const file of sourceFiles) git(dshRoot, ['apply', '--3way', file])
  if (materialized.patches.some(patch => patch.target.kind === 'dsh-source')) {
    runPnpm(dshRoot, ['run', 'build:official'], 'official DSH build after source patches')
  }
}

// Official bundles由dsh CLI dependency tree拥有，private workspace root不承担package resolution。
function officialPackageRoot(dshRoot: string): string {
  return resolve(dshRoot, 'apps', 'cli')
}

/**
 * Parse pnpm's workspace roster into exact official package directories.
 * @param dshRoot - exact official DSH checkout root.
 * @param stdout - JSON emitted by `pnpm -r list --json --depth -1`.
 * @returns sorted official package names and directories inside the checkout.
 */
export function parseOfficialWorkspacePackages(dshRoot: string, stdout: string): OfficialWorkspacePackage[] {
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed)) throw new Error('pnpm workspace package list must be an array')
  const packages = new Map<string, string>()
  for (const [index, value] of parsed.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('pnpm workspace package list[' + String(index) + '] must be an object')
    }
    const entry = value as Record<string, unknown>
    if (typeof entry.name !== 'string' || !entry.name.startsWith('@deepseek-ai/')) continue
    const localName = entry.name.slice('@deepseek-ai/'.length)
    if (localName === '' || localName.includes('/')) {
      throw new Error('unsupported official workspace package name: ' + entry.name)
    }
    if (typeof entry.path !== 'string' || entry.path === '') {
      throw new Error('pnpm workspace package ' + entry.name + ' has no path')
    }
    const directory = resolve(dshRoot, entry.path)
    const local = relative(dshRoot, directory)
    if (isAbsolute(local) || local === '..' || local.startsWith('../')) {
      throw new Error('official workspace package escapes DSH root: ' + entry.name)
    }
    const previous = packages.get(entry.name)
    if (previous !== undefined && previous !== directory) {
      throw new Error('duplicate official workspace package: ' + entry.name)
    }
    packages.set(entry.name, directory)
  }
  return [...packages].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, directory]) => ({ name, directory }))
}

function listOfficialWorkspacePackages(dshRoot: string): OfficialWorkspacePackage[] {
  const result = spawnSync('pnpm', ['-r', 'list', '--json', '--depth', '-1'], {
    cwd: dshRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error('pnpm list official DSH workspace packages failed with exit code ' + String(result.status))
  }
  return parseOfficialWorkspacePackages(dshRoot, result.stdout)
}

/**
 * Build the profile's official scope from the CLI closure plus source workspaces.
 * @param profileDirectory - materialized Plus profile root.
 * @param cliScope - official packages already installed under the DSH CLI.
 * @param workspacePackages - additional official source workspaces required by external peers.
 */
export function materializeOfficialPackageScope(
  profileDirectory: string,
  cliScope: string,
  workspacePackages: readonly OfficialWorkspacePackage[],
): void {
  if (!existsSync(cliScope)) throw new Error('official DSH dependencies are missing under ' + cliScope)
  const destination = resolve(profileDirectory, 'node_modules', '@deepseek-ai')
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  for (const name of readdirSync(cliScope).sort()) {
    symlinkSync(resolve(cliScope, name), resolve(destination, name), linkType)
  }
  for (const entry of workspacePackages) {
    const name = entry.name.slice('@deepseek-ai/'.length)
    const target = resolve(destination, name)
    if (existsSync(target)) continue
    symlinkSync(entry.directory, target, linkType)
  }
}

// Profile plugins resolve official peers from the exact source checkout, including peers outside the CLI closure.
function linkOfficialPackages(profileDirectory: string, dshRoot: string): void {
  const cliScope = resolve(officialPackageRoot(dshRoot), 'node_modules', '@deepseek-ai')
  materializeOfficialPackageScope(profileDirectory, cliScope, listOfficialWorkspacePackages(dshRoot))
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
        ? resolveInstalledPackage(officialPackageRoot(dshRoot), name)
        : resolveInstalledPackage(profileDirectory, name)
      return { name, version: installed.version }
    }),
    dependencies: selection.profileDependencies,
    allowBuilds: selection.allowBuilds,
  }
  const lock = writeLock(profileDirectory, selection.lock)
  process.stdout.write('[dsh-plus] applied ' + String(selection.patches.length) + ' patches; lock ' + lock + '\n')
}
