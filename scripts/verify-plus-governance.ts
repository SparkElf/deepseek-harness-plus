/** Verify Plus npm composition, independent patch packages, and curation ownership. */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { satisfies, valid, validRange } from 'semver'
import { parse } from 'yaml'
import { loadCordisYaml } from './cordis-yaml.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const distributionPath = 'packages/bundle/plus/package.json'
const patchRoot = 'patches/npm'

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
  const source = string(value, label)
  const range = source.startsWith('workspace:') ? source.slice('workspace:'.length) : source
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

function verifySourcePatchApplies(path: string, baseRevision: string): void {
  const parent = mkdtempSync(join(tmpdir(), 'dsh-plus-patch-base-'))
  const checkout = join(parent, 'source')
  const added = spawnSync('git', ['worktree', 'add', '--detach', '--force', checkout, baseRevision], {
    cwd: root,
    encoding: 'utf8',
  })
  if (added.status !== 0) {
    rmSync(parent, { recursive: true, force: true })
    throw new Error('cannot materialize source patch base ' + baseRevision + ': ' + added.stderr.trim())
  }
  try {
    // Strict, because that is what the applier checks first: \`apply.ts\` decides a patch is
    // pending or applied with \`git apply --check\` before it ever runs the three-way merge.
    // A patch that only merges three-way fails that judgement and stops the deployment at
    // 'patch does not apply', which is exactly how two patches shipped in 0.2.0-rc.3 failed
    // after a gate that accepted them because it only tried the merge.
    const strict = spawnSync('git', ['apply', '--check', path], { cwd: checkout, encoding: 'utf8' })
    if (strict.status !== 0) {
      throw new Error('source patch does not apply to base ' + baseRevision + ': ' + path + ': ' + strict.stderr.trim())
    }
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', checkout], { cwd: root, encoding: 'utf8' })
    rmSync(parent, { recursive: true, force: true })
  }
}

/**
 * Whether an npm payload applies to the published package it targets.
 *
 * Both of the obvious local trees are the wrong subject. Running `git apply` inside the
 * repository's `node_modules` proves nothing — that path is ignored, so git skips the
 * file and exits 0 whatever the payload says; measured, a payload with every context line
 * replaced by `MANGLE-XYZ` still returned 0 there. And a workspace copy is neither
 * guaranteed present nor guaranteed pristine: `dsh-better-sidebar` reaches a deployment
 * through the profile's own install, not the workspace's, and a copy left behind by an
 * earlier local experiment does not match what the registry serves.
 *
 * The subject is therefore the published tarball for the declared range, unpacked into a
 * scratch repository so `git apply` acts on a work tree rather than inheriting the
 * repository's ignore rules.
 *
 * @param name - npm package the payload targets.
 * @param range - Version range the payload declares for that package.
 * @param path - Absolute payload file path.
 */
function verifyNpmPatchApplies(name: string, range: string, path: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-npm-patch-check-'))
  try {
    const packed = spawnSync('npm', ['pack', name + '@' + range, '--silent', '--pack-destination', scratch], {
      cwd: scratch,
      encoding: 'utf8',
    })
    if (packed.status !== 0) {
      throw new Error('cannot fetch ' + name + '@' + range + ' from the registry: ' + packed.stderr.trim())
    }
    const tarball = packed.stdout.trim().split('\n').pop() ?? ''
    if (tarball === '') throw new Error('cannot resolve the tarball for ' + name + '@' + range)
    const extracted = spawnSync('tar', ['xzf', join(scratch, tarball), '-C', scratch], { encoding: 'utf8' })
    if (extracted.status !== 0) throw new Error('cannot extract ' + tarball + ': ' + extracted.stderr.trim())
    const published = json(join(scratch, 'package', 'package.json'))
    const version = string(published.version, name + ' published version')
    if (!satisfies(version, range, { includePrerelease: true })) {
      throw new Error(name + ' published version ' + version + ' does not satisfy patch target ' + range)
    }
    const tree = join(scratch, 'package')
    const init = spawnSync('git', ['init', '--quiet'], { cwd: tree, encoding: 'utf8' })
    if (init.status !== 0) throw new Error('cannot initialize the npm patch scratch repository: ' + init.stderr.trim())
    const result = spawnSync('git', ['apply', '--check', path], { cwd: tree, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error('npm patch does not apply to ' + name + '@' + version + ': ' + path + ': ' + result.stderr.trim())
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
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
        verifySourcePatchApplies(payload, baseRevision)
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
    '@changfenhuang/dsh-genui': '0.11.1',
    '@sparkelf/dsh-mineru': '0.1.2',
    '@sparkelf/dsh-officecli': '0.1.2',
    '@sparkelf/dsh-plugin-supervisor': '0.1.6',
    'dsh-sql-workbench': '0.5.1',
    '@sparkelf/dsh-workbench-vault': '0.1.2',
    '@sparkelf/dsh-ssh-manager': '0.7.2',
    '@sparkelf/dsh-api-client': '0.5.1',
    '@huanlin/dsh-plugin-better-locale': '0.4.3',
    'dsh-better-sidebar': '0.21.1',
    // The Office previewer retired at DSH 0.1.7-alpha.2: the official right Sidebar's
    // document tab now renders Office and spreadsheets itself, so the third-party
    // previewer is redundant. The government font assets stay, and reach the official
    // conversion through office-to-pdf's fontDirectories.
    '@sparkelf/dsh-office-viewer-fonts': '0.1.2',
    'dsh-video-preview': '0.1.4',
    // The reviewed session background: a new session's centre column renders it, and every
    // other surface stays official.
    'dsh-right-bg-anim': '1.1.0',
    // Agent Teams is the deployment's team layer: a session's agent becomes a Lead
    // that creates named teammates and shares a durable task board. It needs its
    // profile layer (roster and mailbox) and the Web layer (roster, board, navigation).
    '@deepseek-ai/dsh-experimental-agent-team-profile': '>=0.1.7-rc.2',
    // The mobile face is the community plugin: it carries its own cordis layer and its own
    // client face, so the profile install is the whole integration.
    'dsh-mobile': '>=0.4.6',
    // Agent Teams ships as one profile bundle from 0.1.7-rc.1 on: the profile package now
    // depends on the roster, the Web UI, and the tool packages itself, replacing the separate
    // web-profile bundle that official removed in 9f21d7842a.
  }
  if (JSON.stringify(profileDependencies) !== JSON.stringify(expectedProfileDependencies)) {
    throw new Error('dshPlus.profile.dependencies must own the exact reviewed production bundle set')
  }
  const allowBuilds = object(profile.allowBuilds, 'dshPlus.profile.allowBuilds')
  // Each entry is version-pinned because pnpm matches a transitive dependency by
  // \`name@version\` and replaces an unmatched entry with a placeholder, which makes the
  // install fail rather than merely skip a build.
  // pnpm matches an allowBuilds key by bare package name, whichever version the tree
  // resolves. A name@version key matches only that exact version, and every dependency
  // here is declared with a range, so the resolved version differs between machines —
  // which is how koffi@3.2.1 on one consumer's machine missed a koffi@3.3.0 entry.
  if (JSON.stringify(allowBuilds) !== JSON.stringify({
    '@deepseek-ai/dsh-subprocess-local': true,
    '@google/genai': false,
    '@officecli/officecli': true,
    'cpu-features': false,
    'koffi': true,
    'node-pty': true,
    'oracledb': true,
    'protobufjs': false,
    'ssh2': true,
  })) {
    throw new Error('dshPlus.profile.allowBuilds must match the reviewed production native-build set')
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
    // Every patch package moves with the release, so a minimum-only range like
    // '>=0.1.0-rc.26' silently resolves to whichever older prerelease npm prefers over
    // the one being published: semver excludes 0.2.0-rc.2 from that range, and an install
    // then applies 0.1.x patches whose declared base is the previous official revision.
    // The range has to admit the version this manifest declares.
    // The judgement deliberately omits includePrerelease: that is how npm resolves the
    // range, so a range that does not admit the version under those rules installs an
    // older patch package instead of this one.
    const declared = minimumRange(dependencies[record.name], 'distribution dependencies.' + record.name)
    if (!satisfies(record.version, declared)) {
      throw new Error(record.name + '@' + record.version + ' is not admitted by its own dependency range ' + declared)
    }
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
