import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { parse, stringify } from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const stateRoot = join(repoRoot, '.cache/plus-web-system')
const legacySourceRoot = join(stateRoot, 'official-source')
const buildCacheRoot = join(repoRoot, '.cache/plus-web-build-cache')
const sourceRoot = join(buildCacheRoot, 'official-source')
const cachedProfileRoot = join(buildCacheRoot, 'profile')
const cachedPackagesDir = join(buildCacheRoot, 'packages')
const buildCacheManifestPath = join(buildCacheRoot, 'manifest.json')
const home = join(stateRoot, 'home')
const packagesDir = join(stateRoot, 'packages')
const fixturesDir = join(stateRoot, 'fixtures')
const workspaceDir = join(stateRoot, 'workspace')
const backupWorkspaceDir = join(stateRoot, 'workspace-after-backup')
const runtimePath = join(stateRoot, 'runtime.json')
const logPath = join(home, 'supervisor', 'runtime.log')
const baseURL = 'http://127.0.0.1:3081'
const supervisorURL = 'http://127.0.0.1:3083'
const officialRevision = '0a53fb55bea101816fa226bb964ae2bed71c343b'

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object')
  return value
}

function currentModelSettings(source, label) {
  const settings = requireRecord(parse(source), 'GPT model seed settings')
  const llm = requireRecord(settings['llm-pi-ai'], 'GPT model seed llm-pi-ai')
  const providers = requireRecord(llm.providers, 'GPT model seed providers')
  const matches = []
  for (const [providerId, candidate] of Object.entries(providers)) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const models = Array.isArray(candidate.models) ? candidate.models : []
    for (const model of models) {
      if (model !== null && typeof model === 'object' && !Array.isArray(model) && model.name === label) {
        matches.push({ providerId, provider: candidate, model })
      }
    }
  }
  if (matches.length !== 1) throw new Error('GPT model seed must contain exactly one model matching DSH_PLUS_TEST_MODEL_LABEL')
  const { providerId, provider, model } = matches[0]
  const providerSeed = {}
  for (const key of ['displayName', 'apiKeyEnv', 'api', 'baseURL', 'reasoning']) {
    if (provider[key] !== undefined) providerSeed[key] = provider[key]
  }
  const compatibility = provider.responsesCompatibility
  if (compatibility !== null && typeof compatibility === 'object' && !Array.isArray(compatibility)
    && typeof compatibility.omitReasoningInputStatus === 'boolean') {
    providerSeed.responsesCompatibility = { omitReasoningInputStatus: compatibility.omitReasoningInputStatus }
  }
  const modelSeed = {}
  for (const key of ['id', 'name', 'input', 'contextWindow', 'maxTokens', 'reasoningEfforts']) {
    if (model[key] !== undefined) modelSeed[key] = model[key]
  }
  if (typeof modelSeed.id !== 'string' || modelSeed.id === '') throw new Error('GPT model seed model id is missing')
  providerSeed.models = [modelSeed]
  const defaultModel = { provider: providerId, model: modelSeed.id }
  const sourceDefault = settings['agent-default-model']
  if (sourceDefault !== null && typeof sourceDefault === 'object' && !Array.isArray(sourceDefault)
    && sourceDefault.provider === providerId && sourceDefault.model === modelSeed.id
    && typeof sourceDefault.reasoningEffort === 'string') {
    defaultModel.reasoningEffort = sourceDefault.reasoningEffort
  }
  return {
    'llm-pi-ai': { providers: { [providerId]: providerSeed } },
    'agent-default-model': defaultModel,
  }
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    throw new Error([`Command failed: ${command} ${args.join(' ')}`, result.stdout, result.stderr].filter(Boolean).join('\n'))
  }
  return result.stdout.trim()
}

async function portAvailable(port) {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)))
  }).catch(() => false)
}

function writePdf(path) {
  const stream = [
    'BT',
    '/F1 28 Tf',
    '72 680 Td',
    '(DeepSeek Harness document preview) Tj',
    '0 -64 Td',
    '/F1 20 Tf',
    '(This fixture verifies parsed document content.) Tj',
    '0 -42 Td',
    '(The expected phrase is PLUS DOCUMENT OK.) Tj',
    '0 -42 Td',
    '(Visible text must reach Chat and Trajectory preview.) Tj',
    'ET',
  ].join('\n') + '\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let document = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(document))
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(document)
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  document += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  writeFileSync(path, document)
}

function packageDirectories() {
  const local = [
    'packages/bundle/plus',
    'packages/plus/backup',
    'packages/plus/dataops',
    'packages/plus/document-attachments',
    'packages/plus/mcp-credentials',
    'packages/plus/subagent-settings',
  ]
  const patchesRoot = join(repoRoot, 'patches/npm')
  const patches = readdirSync(patchesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(patchesRoot, entry.name, 'package.json')))
    .map(entry => `patches/npm/${entry.name}`)
    .sort()
  return [...local, ...patches]
}

function packCandidateArchives(directories) {
  run('pnpm', ['exec', 'tsx', 'scripts/release/pack.ts', '--family', 'plus', '--out', packagesDir], repoRoot)
  const archivesByName = new Map()
  for (const file of readdirSync(packagesDir).filter(file => file.endsWith('.tgz')).sort()) {
    const archive = join(packagesDir, file)
    const manifest = requireRecord(JSON.parse(run('tar', ['-xOzf', archive, 'package/package.json'], repoRoot)), `${file} manifest`)
    if (typeof manifest.name !== 'string' || manifest.name === '' || archivesByName.has(manifest.name)) {
      throw new Error(`Plus release pack produced an invalid package identity in ${file}`)
    }
    archivesByName.set(manifest.name, archive)
  }
  if (archivesByName.size !== directories.length) {
    throw new Error('Plus Web package inventory differs from the Plus release family')
  }
  return new Map(directories.map(directory => {
    const manifest = requireRecord(JSON.parse(readFileSync(join(repoRoot, directory, 'package.json'), 'utf8')), `${directory} manifest`)
    const archive = archivesByName.get(manifest.name)
    if (archive === undefined) throw new Error(`Plus release pack omitted ${String(manifest.name)}`)
    return [directory, archive]
  }))
}

/** Cache key只取会改变official build/profile的声明输入，不纳入凭据、模型选择或运行数据。 */
function buildCacheDescriptor(directories, archives) {
  const packages = directories.map(directory => ({
    directory,
    sha256: createHash('sha256').update(readFileSync(archives.get(directory))).digest('hex'),
  }))
  const descriptor = {
    formatVersion: 1,
    officialRevision,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    pnpm: run('pnpm', ['--version'], repoRoot),
    packages,
  }
  return {
    ...descriptor,
    key: createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),
  }
}

function readBuildCacheManifest() {
  if (!existsSync(buildCacheManifestPath)) return null
  const manifest = requireRecord(JSON.parse(readFileSync(buildCacheManifestPath, 'utf8')), 'Plus Web build cache manifest')
  if (manifest.formatVersion !== 1 || typeof manifest.key !== 'string' || manifest.key === '') {
    throw new Error('Plus Web build cache manifest is invalid')
  }
  return manifest
}

function resetBuildCache() {
  if (existsSync(sourceRoot)) run('git', ['worktree', 'remove', '--force', sourceRoot], repoRoot)
  rmSync(buildCacheRoot, { recursive: true, force: true })
  mkdirSync(cachedPackagesDir, { recursive: true })
}

function cacheArchives(directories, packedArchives) {
  return new Map(directories.map(directory => {
    const source = packedArchives.get(directory)
    const destination = join(cachedPackagesDir, basename(source))
    copyFileSync(source, destination)
    return [directory, destination]
  }))
}

function existingCacheArchives(directories, packedArchives) {
  return new Map(directories.map(directory => {
    const archive = join(cachedPackagesDir, basename(packedArchives.get(directory)))
    if (!existsSync(archive)) throw new Error(`Plus Web build cache is missing ${basename(archive)}`)
    return [directory, archive]
  }))
}

/** Profile template不含用户数据；每轮以hardlink新建目录树，运行状态只写独立home。 */
function restoreCachedProfile(profileRoot) {
  if (!existsSync(join(sourceRoot, 'apps/cli/lib/bin.js')) || !existsSync(join(cachedProfileRoot, 'package.json'))) {
    throw new Error('Plus Web build cache marker exists without its built source and profile')
  }
  mkdirSync(dirname(profileRoot), { recursive: true })
  run('cp', ['-al', cachedProfileRoot, profileRoot], repoRoot)
}

function writeBuildCacheManifest(descriptor) {
  const temporary = buildCacheManifestPath + '.tmp'
  writeFileSync(temporary, JSON.stringify(descriptor, null, 2) + '\n')
  renameSync(temporary, buildCacheManifestPath)
}

function sanitizedRuntimeLog() {
  return readFileSync(logPath, 'utf8').replace(/([?&]token=)[^&\s]+/gu, '$1[redacted]')
}

async function waitForWeb(child) {
  const deadline = Date.now() + 10 * 60_000
  const launchPrefix = `dsh web: ${baseURL}/`
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Plus Web exited before readiness with code ${String(child.exitCode)}\n${sanitizedRuntimeLog()}`)
    }
    const launchLine = readFileSync(logPath, 'utf8').split(/\r?\n/u).find(line => line.startsWith(launchPrefix))
    const launchURL = launchLine?.slice('dsh web: '.length).split(/\s/u, 1)[0]
    if (launchURL !== undefined) {
      try {
        const response = await fetch(launchURL, { redirect: 'manual' })
        if (launchURL === `${baseURL}/` && response.status === 200) {
          return launchURL
        }
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
      }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  throw new Error(`Timed out waiting for ${baseURL}\n${sanitizedRuntimeLog()}`)
}

export default async function globalSetup() {
  const required = [
    'DSH_PLUS_TEST_MODEL_SEED_HOME',
    'DSH_PLUS_TEST_MODEL_LABEL',
    'DSH_MINERU_ENDPOINT',
    'DSH_DATAOPS_BASE_URL',
  ]
  const missing = required.filter(name => process.env[name] === undefined || process.env[name] === '')
  if (missing.length > 0) throw new Error(`Plus Web system acceptance requires: ${missing.join(', ')}`)
  if (!(await portAvailable(3081))) throw new Error('Plus Web system acceptance requires unused port 3081; production 3080 is never reused or stopped.')

  if (existsSync(legacySourceRoot)) run('git', ['worktree', 'remove', '--force', legacySourceRoot], repoRoot)
  rmSync(stateRoot, { recursive: true, force: true })
  mkdirSync(packagesDir, { recursive: true })
  mkdirSync(fixturesDir, { recursive: true })
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(backupWorkspaceDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  const modelSeedHome = resolve(process.env.DSH_PLUS_TEST_MODEL_SEED_HOME)
  const settingsSource = join(modelSeedHome, 'settings.yaml')
  const credentialsSource = join(modelSeedHome, '.credentials.yaml')
  if (!existsSync(settingsSource) || !existsSync(credentialsSource)) {
    throw new Error('GPT model seed requires settings.yaml and .credentials.yaml')
  }
  const settingsDestination = join(home, 'settings.yaml')
  writeFileSync(
    settingsDestination,
    stringify(currentModelSettings(readFileSync(settingsSource, 'utf8'), process.env.DSH_PLUS_TEST_MODEL_LABEL)),
  )
  chmodSync(settingsDestination, 0o600)
  const credentialsDestination = join(home, '.credentials.yaml')
  copyFileSync(credentialsSource, credentialsDestination)
  chmodSync(credentialsDestination, 0o600)
  const directories = packageDirectories()
  const distributionDirectory = 'packages/bundle/plus'
  const mcpDirectory = 'packages/plus/mcp-credentials'
  const packedArchives = packCandidateArchives(directories)
  const cacheDescriptor = buildCacheDescriptor(directories, packedArchives)
  const cacheHit = readBuildCacheManifest()?.key === cacheDescriptor.key
  let archives
  if (cacheHit) {
    console.log(`[plus-web] build cache hit ${cacheDescriptor.key.slice(0, 12)}`)
    archives = existingCacheArchives(directories, packedArchives)
  } else {
    console.log(`[plus-web] build cache miss ${cacheDescriptor.key.slice(0, 12)}`)
    resetBuildCache()
    archives = cacheArchives(directories, packedArchives)
    run('git', ['worktree', 'add', '--force', '--detach', sourceRoot, officialRevision], repoRoot)
    run('pnpm', ['install', '--frozen-lockfile'], sourceRoot)
  }
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_DATAOPS_CALLBACK_ORIGIN: baseURL,
  }
  const profileRoot = join(home, 'profiles', 'plus')
  if (cacheHit) {
    restoreCachedProfile(profileRoot)
  } else {
    mkdirSync(profileRoot, { recursive: true })
    const overrides = {
      ...Object.fromEntries(directories.map((directory) => {
        const manifest = JSON.parse(readFileSync(join(repoRoot, directory, 'package.json'), 'utf8'))
        return [manifest.name, `file:${archives.get(directory)}`]
      })),
      'dsh-better-sidebar': '0.17.1',
      '@huanlin/dsh-plugin-better-sidebar-plugin-office': '0.1.2',
      'dsh-video-preview': '0.1.4',
      'dsh-univer-office': '0.2.12',
      '@sparkelf/dsh-mobile-bridge': '0.2.10',
    }
    writeFileSync(
      join(profileRoot, 'pnpm-workspace.yaml'),
      stringify({ packages: ['.'], overrides, autoInstallPeers: false }),
    )
    const mcpArchive = archives.get(mcpDirectory)
    const dependencyArchives = directories
      .filter(directory => directory !== distributionDirectory && directory !== mcpDirectory)
      .map(directory => archives.get(directory))
    const distributionArchive = archives.get(distributionDirectory)
    run('pnpm', ['dsh', 'plugin', '--profile', 'plus', 'add', '-w', mcpArchive], repoRoot, env)
    run('pnpm', ['dsh', 'plugin', '--profile', 'plus', 'add', '-w', ...dependencyArchives], repoRoot, env)
    run('pnpm', ['dsh', 'plugin', '--profile', 'plus', 'add', '-w', distributionArchive], repoRoot, env)
    run('pnpm', ['dsh', 'plugin', '--profile', 'plus', 'exec', 'dsh-plus', 'apply', '--dsh-root', sourceRoot], repoRoot, env)
  }
  const profileManifest = JSON.parse(readFileSync(join(profileRoot, 'package.json'), 'utf8'))
  const externalBundles = {
    '@huanlin/dsh-plugin-better-sidebar-plugin-office': '0.1.2',
    'dsh-video-preview': '0.1.4',
    'dsh-univer-office': '0.2.12',
  }
  for (const [packageName, version] of Object.entries(externalBundles)) {
    if (profileManifest.dependencies?.[packageName] !== version
      || !profileManifest.dsh?.profile?.bundles?.includes(packageName)) {
      throw new Error(`Plus profile did not materialize ${packageName}@${version}`)
    }
    const installedManifest = JSON.parse(readFileSync(join(profileRoot, 'node_modules', packageName, 'package.json'), 'utf8'))
    if (installedManifest.name !== packageName || installedManifest.version !== version) {
      throw new Error(`Plus profile installed the wrong ${packageName} version`)
    }
  }
  const profileOfficialScope = realpathSync(join(profileRoot, 'node_modules', '@deepseek-ai'))
  const officialRoot = realpathSync(sourceRoot)
  for (const packageName of readdirSync(profileOfficialScope)) {
    const profilePackage = realpathSync(join(profileOfficialScope, packageName))
    const sourceRelative = relative(officialRoot, profilePackage)
    const manifest = JSON.parse(readFileSync(join(profilePackage, 'package.json'), 'utf8'))
    if (
      isAbsolute(sourceRelative)
      || sourceRelative === '..'
      || sourceRelative.startsWith('../')
      || manifest.name !== `@deepseek-ai/${packageName}`
    ) {
      throw new Error(`Plus profile official package must resolve from the exact DSH checkout: @deepseek-ai/${packageName}`)
    }
  }
  if (!cacheHit) {
    rmSync(join(profileRoot, '.dsh-market'), { recursive: true, force: true })
    renameSync(profileRoot, cachedProfileRoot)
    restoreCachedProfile(profileRoot)
    writeBuildCacheManifest(cacheDescriptor)
  }
  writePdf(join(fixturesDir, 'acceptance.pdf'))
  writeFileSync(join(fixturesDir, 'not-a-backup.zip'), zipSync({ 'ordinary.txt': strToU8('Not a DeepSeek Harness backup.\n') }))
  const supervisorDirectory = join(home, 'supervisor')
  mkdirSync(supervisorDirectory, { recursive: true })
  const supervisorManifestPath = join(supervisorDirectory, 'system-test.json')
  writeFileSync(logPath, '')
  const supervisorSocketPath = join(supervisorDirectory, 'system-test.sock')
  writeFileSync(supervisorManifestPath, JSON.stringify({
    dshHome: home,
    port: 3081,
    supervisorPort: 3083,
    socketPath: supervisorSocketPath,
    runtime: {
      command: process.execPath,
      args: [join(sourceRoot, 'apps/cli/lib/bin.js'), '--profile', 'plus', '--port', '3081', '--no-open'],
      cwd: sourceRoot,
    },
  }, null, 2) + '\n')
  const supervisorEntry = join(profileRoot, 'node_modules', '@sparkelf', 'dsh-plugin-supervisor', 'runtime', 'bin.mjs')
  const log = openSync(join(supervisorDirectory, 'process.log'), 'w')
  const child = spawn(process.execPath, [supervisorEntry, '--manifest', supervisorManifestPath], {
    cwd: sourceRoot,
    env,
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  closeSync(log)
  writeFileSync(runtimePath, JSON.stringify({
    pid: child.pid,
    sourceRoot,
    home,
    baseURL,
    supervisorURL,
    supervisorManifestPath,
    supervisorSocketPath,
    logPath,
  }, null, 2) + '\n')
  try {
    process.env.DSH_PLUS_TEST_START_URL = await waitForWeb(child)
  } catch (error) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (killError) {
      if (killError?.code !== 'ESRCH') throw new AggregateError([error, killError], 'Plus Web readiness and cleanup failed')
    }
    throw error
  }
}
