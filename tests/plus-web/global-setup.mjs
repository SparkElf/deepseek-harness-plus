import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { parse, stringify } from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const stateRoot = join(repoRoot, '.cache/plus-web-system')
const sourceRoot = join(stateRoot, 'official-source')
const home = join(stateRoot, 'home')
const packagesDir = join(stateRoot, 'packages')
const fixturesDir = join(stateRoot, 'fixtures')
const workspaceDir = join(stateRoot, 'workspace')
const runtimePath = join(stateRoot, 'runtime.json')
const logPath = join(stateRoot, 'runtime.log')
const baseURL = 'http://127.0.0.1:3081'
const officialRevision = 'cd5ef8148158c3a752a658978873241fdf8e2bbc'

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
  const stream = 'BT /F1 18 Tf 72 720 Td (PLUS_DOCUMENT_OK) Tj ET\n'
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
  return [...local, ...patches]
}


function pack(directory) {
  const output = run('pnpm', ['pack', '--pack-destination', packagesDir], join(repoRoot, directory))
  const archive = output.split(/\r?\n/u).findLast(line => line.trim().endsWith('.tgz'))
  if (archive === undefined) throw new Error(`pnpm pack did not report an archive for ${directory}`)
  return resolve(join(repoRoot, directory), archive.trim())
}

function sanitizedRuntimeLog() {
  return readFileSync(logPath, 'utf8').replace(/([?&]token=)[^&\s]+/gu, '$1[redacted]')
}

async function waitForWeb(child) {
  const deadline = Date.now() + 10 * 60_000
  const launchPrefix = `dsh web: ${baseURL}/?token=`
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Plus Web exited before readiness with code ${String(child.exitCode)}\n${sanitizedRuntimeLog()}`)
    }
    const launchLine = readFileSync(logPath, 'utf8').split(/\r?\n/u).find(line => line.startsWith(launchPrefix))
    const launchURL = launchLine?.slice('dsh web: '.length).split(/\s/u, 1)[0]
    if (launchURL !== undefined) {
      try {
        const response = await fetch(launchURL, { redirect: 'manual' })
        const location = response.headers.get('location')
        if (response.status === 303 && location !== null && new URL(location, launchURL).href === `${baseURL}/`) {
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

  if (existsSync(sourceRoot)) run('git', ['worktree', 'remove', '--force', sourceRoot], repoRoot)
  rmSync(stateRoot, { recursive: true, force: true })
  mkdirSync(packagesDir, { recursive: true })
  mkdirSync(fixturesDir, { recursive: true })
  mkdirSync(workspaceDir, { recursive: true })
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
  run('git', ['worktree', 'add', '--force', '--detach', sourceRoot, officialRevision], repoRoot)
  run('pnpm', ['install', '--frozen-lockfile'], sourceRoot)

  const directories = packageDirectories()
  const distributionDirectory = 'packages/bundle/plus'
  const mcpDirectory = 'packages/plus/mcp-credentials'
  const archives = new Map(directories.map(directory => [directory, pack(directory)]))
  const mcpArchive = archives.get(mcpDirectory)
  const dependencyArchives = directories
    .filter(directory => directory !== distributionDirectory && directory !== mcpDirectory)
    .map(directory => archives.get(directory))
  const distributionArchive = archives.get(distributionDirectory)
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_DATAOPS_CALLBACK_ORIGIN: baseURL,
  }
  const profileRoot = join(home, 'profiles', 'plus')
  mkdirSync(profileRoot, { recursive: true })
  const overrides = {
    ...Object.fromEntries(directories.map((directory) => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, directory, 'package.json'), 'utf8'))
      return [manifest.name, `file:${archives.get(directory)}`]
    })),
    'dsh-better-sidebar': '0.17.1',
    '@sparkelf/dsh-mobile-bridge': '0.2.8',
  }
  writeFileSync(
    join(profileRoot, 'pnpm-workspace.yaml'),
    stringify({ packages: ['.'], overrides, autoInstallPeers: false }),
  )
  run('pnpm', ['dsh', 'plugin', '--profile', 'plus', 'add', '-w', mcpArchive], repoRoot, env)
  run('pnpm', ['dsh', 'plugin', '--profile', 'plus', 'add', '-w', ...dependencyArchives], repoRoot, env)
  run('pnpm', ['dsh', 'plugin', '--profile', 'plus', 'add', '-w', distributionArchive], repoRoot, env)
  run('pnpm', ['dsh', 'plugin', '--profile', 'plus', 'exec', 'dsh-plus', 'apply', '--dsh-root', sourceRoot], repoRoot, env)
  const profileOfficialScope = realpathSync(join(profileRoot, 'node_modules', '@deepseek-ai'))
  const cliOfficialScope = realpathSync(join(sourceRoot, 'apps', 'cli', 'node_modules', '@deepseek-ai'))
  if (profileOfficialScope !== cliOfficialScope) throw new Error('Plus profile official scope must resolve from the dsh CLI dependency tree')
  writePdf(join(fixturesDir, 'acceptance.pdf'))
  writeFileSync(join(fixturesDir, 'not-a-backup.zip'), zipSync({ 'ordinary.txt': strToU8('Not a DeepSeek Harness backup.\n') }))
  const log = openSync(logPath, 'w')
  const child = spawn(process.execPath, [join(sourceRoot, 'apps/cli/lib/bin.js'), '--profile', 'plus', '--port', '3081', '--no-open'], {
    cwd: sourceRoot,
    env,
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  closeSync(log)
  writeFileSync(runtimePath, JSON.stringify({ pid: child.pid, sourceRoot, home, baseURL, logPath }, null, 2) + '\n')
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
