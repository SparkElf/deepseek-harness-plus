/**
 * The `dsh-plus` command line for a standalone installation.
 *
 * The commands exist because the launcher underneath is a developer surface: it
 * refuses an existing profile, reports a taken port as a module-resolution stack
 * trace, and exits with the terminal. This dispatcher supplies the missing product
 * layer — a profile created on first start, a free port chosen without asking, a
 * server that survives the terminal, and one place to read the URL.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newerVersion } from './registry-versions.ts'
import {
  CAPABILITIES,
  CAPABILITY_ENV_FILE,
  CAPABILITY_MARKER,
  CAPABILITY_RECORD,
  DEFAULT_MINERU_ENDPOINT,
  capabilityEnvironment,
  capabilityPatchLayer,
  installCapabilityServices,
  interviewCapabilities,
  type CapabilityAnswers,
} from './standalone-capabilities.ts'
import {
  DEFAULT_PORT,
  STOP_GRACE_MILLISECONDS,
  choosePort,
  clearState,
  isRunning,
  portAvailable,
  readState,
  spawnServer,
  stateDirectory,
  waitForAuthenticatedUrl,
  waitForServer,
  writeState,
} from './standalone-server.ts'
import {
  STANDALONE_PROFILE,
  applyProfileNpmPatches,
  ensureProfile,
  pnpmAvailable,
  pnpmInstallCommand,
  pnpmInstallCommands,
  registryOrder,
  readDistributionProfile,
  resolvePaths,
  type StandalonePaths,
} from './standalone-profile.ts'

/** Milliseconds a start waits for the server to answer before reporting failure. */
const READY_TIMEOUT_MILLISECONDS = 90_000

/** Profile patch file the capability interview rewrites (the profile's user layer). */
const CAPABILITY_PATCH_FILE = 'cordis.patch.yml'

interface StartOptions {
  readonly port: number
  readonly host: string
  readonly open: boolean
  readonly foreground: boolean
  /**
   * Capabilities to enable without asking, or undefined to interview.
   *
   * An unattended install has no terminal to answer the interview, so a build that
   * bakes a profile into an image states the selection instead. An empty list is a
   * selection too: it means every optional capability stays off, which is what a
   * deployment that must not run them requires.
   */
  readonly capabilities: readonly string[] | undefined
}

function parseStartOptions(argv: readonly string[]): StartOptions {
  let port = DEFAULT_PORT
  let host = '127.0.0.1'
  let open = true
  let foreground = false
  let capabilities: readonly string[] | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--port' || token === '-p') {
      const value = argv[index + 1]
      if (value === undefined || !/^\d+$/u.test(value)) throw new Error('--port requires a number')
      port = Number(value)
      index += 1
      continue
    }
    if (token === '--host') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--host requires a value')
      host = value
      index += 1
      continue
    }
    if (token === '--no-open') { open = false; continue }
    if (token === '--foreground') { foreground = true; continue }
    if (token === '--capabilities') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--capabilities requires a comma-separated list, or an empty string for none')
      const stated = value === '' ? [] : value.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
      // A stated selection is the only way an unattended install chooses capabilities, so
      // a name this release does not offer fails here: the deployment would otherwise
      // start without a capability its caller believes it selected. Validating at parse
      // time also makes the failure independent of what is installed.
      const offered = new Set(CAPABILITIES.map(capability => capability.id))
      for (const id of stated) {
        if (!offered.has(id)) {
          throw new Error('unknown capability "' + id + '"; this release offers ' + [...offered].join(', '))
        }
      }
      capabilities = stated
      index += 1
      continue
    }
    throw new Error('unknown option: ' + String(token))
  }
  return { port, host, open, foreground, capabilities }
}

/**
 * Resolve a stated capability selection.
 *
 * An unattended install states what it wants instead of answering the interview, so a
 * name it does not offer has to fail here rather than silently enable nothing: the
 * deployment would otherwise start with a capability the caller believes it selected.
 *
 * @param ids - capability ids the caller selected.
 * @returns the answers the interview would have returned.
 */
function selectCapabilities(ids: readonly string[]): CapabilityAnswers {
  const selected = [...new Set(ids)]
  // MinerU is started from an endpoint the interview collects; an unattended install
  // gets the documented default rather than an unset one.
  return {
    enabled: selected,
    ...selected.includes('mineru') ? { mineruEndpoint: DEFAULT_MINERU_ENDPOINT } : {},
  }
}

/**
 * Where the installation that owns this command keeps its packages.
 *
 * A global install places the command in a shared prefix and a local install places
 * it in a project; neither has anything to do with the directory the user happens to
 * be in. The search therefore starts at this module own file and climbs to the tree
 * npm laid out around it.
 *
 * The test is the launcher, not the distribution: inside a workspace the package
 * resolves its own name, so looking for the distribution would stop at the package
 * rather than at the tree that owns every dependency.
 *
 * @returns absolute path to the installation root.
 */
function installationRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  let current = here
  for (;;) {
    if (existsSync(join(current, 'node_modules', '@deepseek-ai', 'dsh'))) return current
    const parent = dirname(current)
    // A tree npm did not lay out has no such ancestor; the module own directory
    // keeps the failure message pointing at the installation that was searched.
    if (parent === current) return here
    current = parent
  }
}

/** The package.json this installation resolves its dependencies from. */
function installationAnchor(): string {
  return join(installationRoot(), 'package.json')
}

/**
 * Path to the installed command's own file, which is where a declaration lookup starts.
 *
 * The declaration belongs to the package the user installed, and that package is a
 * sibling of this module rather than an ancestor: a variant's forwarder imports this
 * CLI in-process, so `import.meta.url` names `@sparkelf/dsh-plus` while the installed
 * command is the variant. `process.argv[1]` is the entry that was actually invoked,
 * which is the package whose declaration applies.
 *
 * Walking out from the installation root cannot reach it either: that root is the
 * project the user ran the command in, so every variant would fall back to the full
 * profile and keep the capabilities it excluded.
 *
 * @returns absolute path to the invoked command, or this module when argv carries none.
 */
function declarationAnchor(): string {
  const invoked = process.argv[1]
  return invoked === undefined || invoked === '' ? fileURLToPath(import.meta.url) : resolve(invoked)
}
/** The launcher entry this installation must drive. */
function launcherEntry(anchor: string): string {
  return createRequire(anchor).resolve('@deepseek-ai/dsh/lib/bin.js')
}

/** Run the server in this process, inheriting stdio. */
function runForeground(entry: string, profileName: string, port: number, host: string, open: boolean): number {
  const args = [entry, '--profile', profileName, '--port', String(port), '--host', host]
  if (!open) args.push('--no-open')
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  return result.status ?? 1
}

async function start(argv: readonly string[]): Promise<number> {
  const options = parseStartOptions(argv)
  const anchor = installationAnchor()
  // The profile's own name and omissions come from the package that installed this
  // command, which is a different tree position than the dependencies it resolves.
  const paths = resolvePaths(declarationAnchor())
  // The profile installs its own dependency tree, which needs pnpm. Asking here rather
  // than failing inside the install turns a missing prerequisite into a decision the
  // consumer makes, and the install it can run is the one command that provides it.
  if (!pnpmAvailable()) {
    const command = pnpmInstallCommand()
    console.log('pnpm is required to install the ' + STANDALONE_PROFILE + ' profile, and was not found.')
    console.log('Install it with: ' + command)
    if (!await confirm('Install pnpm now?')) {
      console.log('Install pnpm and run dsh-plus start again.')
      return 1
    }
    // Try each installer in turn: Corepack is absent on an installation that disabled it,
    // and npm succeeds there. A failure reports the commands rather than a stack trace.
    let installed = false
    const preferred = registryOrder()[0]
    for (const candidate of pnpmInstallCommands()) {
      // Corepack reads its registry from the environment; npm takes a flag, which the
      // command already carries. Setting it for both keeps the download on the mirror.
      const attempt = spawnSync(candidate, {
        stdio: 'inherit',
        shell: true,
        env: preferred === undefined
          ? process.env
          : { ...process.env, COREPACK_NPM_REGISTRY: preferred },
      })
      if (attempt.status === 0 && pnpmAvailable()) { installed = true; break }
    }
    if (!installed) {
      console.log('Could not install pnpm automatically.')
      console.log('Run one of these, then run dsh-plus start again:')
      for (const candidate of pnpmInstallCommands()) console.log('  ' + candidate)
      return 1
    }
    console.log('pnpm installed.')
  }
  const created = ensureProfile(paths, installationRoot())
  console.log(created
    ? 'Created the ' + paths.profileName + ' profile at ' + paths.profileDirectory
    : 'Using the existing ' + paths.profileName + ' profile')
  // The profile symlinks the consumer's packages, so a patch lands on the installed
  // copy the launcher loads. A reinstall restores the published bytes, which is why
  // this runs on every start rather than only when the profile was created.
  for (const label of applyProfileNpmPatches(paths.distributionDirectory, paths.profileDirectory)) {
    console.log('Applied the reviewed patch ' + label)
  }
  // The capability interview runs once, when the profile is created: a deployment
  // that already answered keeps its answers, and a re-run only reports them. Asking
  // on every start would make a restart look like a first install.
  const needsInterview = created || !existsSync(join(paths.home, CAPABILITY_RECORD))
  const answers = needsInterview
    ? options.capabilities === undefined
      ? await interviewCapabilities(true)
      : selectCapabilities(options.capabilities)
    : undefined
  if (answers !== undefined) {
    const ready = await installCapabilityServices(answers, paths.home)
    writeCapabilityPatch(paths.profileDirectory, answers)
    writeCapabilityEnvironment(paths.home, answers)
    console.log('  Enabled: ' + (answers.enabled.length === 0 ? '(none)' : answers.enabled.join(', ')))
    if (answers.enabled.length > 0) console.log('  Services ready: ' + (ready.length === 0 ? '(none)' : ready.join(', ')))
    if (answers.enabled.includes('exa') && answers.exaApiKey === undefined) {
      console.log('  Exa: add EXA_API_KEY to ' + join(paths.home, CAPABILITY_ENV_FILE) + ' when you have a key.')
    }
  }

  const entry = launcherEntry(anchor)
  if (options.foreground) return runForeground(entry, paths.profileName, options.port, options.host, options.open)

  const existing = readState(paths.home)
  if (existing !== undefined) {
    console.log('Plus is already running at ' + existing.url)
    console.log('Stop it with: dsh-plus stop')
    return 0
  }

  return startDetached(paths, entry, options)
}

async function startDetached(paths: StandalonePaths, entry: string, options: StartOptions): Promise<number> {
  const home = paths.home
  const port = await choosePort(options.port, options.host)
  if (port === undefined) {
    console.error('No free port in the range ' + String(options.port) + '-' + String(options.port + 9) + '.')
    console.error('Pass --port with a free port.')
    return 1
  }
  if (port !== options.port) console.log('Port ' + String(options.port) + ' is in use; using ' + String(port) + '.')
  const logPath = join(stateDirectory(paths.home), 'server.log')
  const env = { ...process.env, DSH_HOME: paths.home }
  const args = [entry, '--profile', paths.profileName, '--port', String(port), '--host', options.host, '--no-open']
  const pid = spawnServer({ command: process.execPath, args, env, logPath })
  const url = 'http://' + options.host + ':' + String(port) + '/'
  const ready = await waitForServer(url, READY_TIMEOUT_MILLISECONDS)
  if (!ready) {
    console.error('The server did not answer within ' + String(READY_TIMEOUT_MILLISECONDS / 1000) + 's.')
    console.error('Read ' + logPath + ' for the startup error.')
    if (isRunning(pid)) process.kill(pid, 'SIGTERM')
    return 1
  }
  // The launcher prints the URL carrying the process launch token, and the server
  // refuses every request without the cookie that token mints. Reporting the bare
  // address sends the user to a 401 that tells them to reopen the launcher's URL,
  // which lives only in the log this command points at.
  const opened = await waitForAuthenticatedUrl(logPath, READY_TIMEOUT_MILLISECONDS) ?? url
  writeState(home, { pid, port, url: opened })
  console.log('Plus is running at ' + opened)
  console.log('Logs: ' + logPath)
  console.log('Stop it with: dsh-plus stop')
  return 0
}

async function stop(): Promise<number> {
  const anchor = installationAnchor()
  const { home } = resolvePaths(anchor)
  const state = readState(home)
  if (state === undefined) {
    clearState(home)
    console.log('Plus is not running.')
    return 0
  }
  process.kill(state.pid, 'SIGTERM')
  const deadline = Date.now() + STOP_GRACE_MILLISECONDS
  while (Date.now() < deadline && isRunning(state.pid)) {
    await new Promise((resolveDelay) => { setTimeout(resolveDelay, 200) })
  }
  if (isRunning(state.pid)) {
    console.log('The server did not exit in ' + String(STOP_GRACE_MILLISECONDS / 1000) + 's; forcing it.')
    process.kill(state.pid, 'SIGKILL')
  }
  clearState(home)
  console.log('Plus has stopped.')
  return 0
}

function status(): number {
  const anchor = installationAnchor()
  const paths = resolvePaths(anchor)
  const state = readState(paths.home)
  if (state === undefined) {
    console.log('Plus is not running.')
    console.log('Start it with: dsh-plus start')
    return 0
  }
  console.log('Plus is running at ' + state.url)
  console.log('Process ' + String(state.pid) + ' on port ' + String(state.port))
  return 0
}

/**
 * Move the installation to a newer published release.
 *
 * The profile pins the distribution exactly, so the new version is written into the
 * profile manifest and reinstalled there. A running server keeps the version it
 * started with, so the command reports that a restart is what makes the change take
 * effect rather than pretending the running process changed underneath the user.
 */
async function update(argv: readonly string[]): Promise<number> {
  const checkOnly = argv.includes('--check')
  const assumeYes = argv.includes('--yes')
  const anchor = installationAnchor()
  const paths = resolvePaths(anchor)
  const distribution = readDistributionProfile(paths.distributionDirectory)
  const installed = distribution.version
  const newer = newerVersion(distribution.name, installed)
  if (newer === undefined) {
    console.log('Plus ' + installed + ' is the newest published release.')
    return 0
  }
  console.log('Installed: ' + installed)
  console.log('Available: ' + newer.version + (newer.publishedAt === undefined ? '' : ' (' + newer.publishedAt + ')'))
  if (checkOnly) return 0
  if (!assumeYes && !(await confirm('Install ' + newer.version + '?'))) {
    console.log('Nothing changed.')
    return 0
  }
  const profilePath = join(paths.profileDirectory, 'package.json')
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>
  const dependencies = profile.dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error('the profile manifest has no dependencies to update')
  }
  ;(dependencies as Record<string, string>)['@sparkelf/dsh-plus'] = newer.version
  writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n')
  console.log('Updated the profile to ' + newer.version + '; installing...')
  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: paths.profileDirectory,
    stdio: 'inherit',
    env: { ...process.env, DSH_HOME: paths.home },
  })
  if (result.status !== 0) {
    console.error('The install failed; the profile still requests ' + newer.version + '.')
    return 1
  }
  console.log('Plus is now ' + newer.version + '.')
  const running = readState(paths.home)
  if (running !== undefined) {
    console.log('The running server still serves ' + installed + '; run dsh-plus restart to load the new release.')
  }
  return 0
}

/**
 * Write the profile's capability patch layer.
 *
 * The profile's loader merges this file, so enabling a capability is a data change
 * rather than an edit to the deployment. Writing it on every configured run also
 * turns a capability back off when the interview no longer selects it.
 *
 * @param profileDirectory - the profile whose layer is replaced.
 * @param answers - the interview's answers.
 */
function writeCapabilityPatch(profileDirectory: string, answers: CapabilityAnswers): void {
  const path = join(profileDirectory, CAPABILITY_PATCH_FILE)
  // The profile has exactly one user layer, so the capability rows live in it. A file
  // this command did not write belongs to the deployment, and replacing it would drop
  // whatever the operator put there; keep it beside the new layer instead.
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  if (existing !== undefined && !existing.includes(CAPABILITY_MARKER)) {
    writeFileSync(path + '.before-capabilities', existing)
    console.log('  Kept the existing profile layer at ' + CAPABILITY_PATCH_FILE + '.before-capabilities')
  }
  writeFileSync(path, capabilityPatchLayer(answers))
}

/**
 * Write the deployment's capability environment file.
 *
 * MinerU is switched on by the presence of its endpoint and Exa reads its key from
 * the launch environment, so the answers reach those two through `$DSH_HOME/.env`
 * rather than through the profile layer. The file is replaced whole on every
 * configured start, which is also how a capability the user dropped stops applying.
 *
 * @param home - the deployment home whose env file the launcher reads.
 * @param answers - the interview's answers.
 */
function writeCapabilityEnvironment(home: string, answers: CapabilityAnswers): void {
  const path = join(home, CAPABILITY_ENV_FILE)
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  writeFileSync(path, capabilityEnvironment(answers, existing))
}

/** Ask one yes/no question on the terminal. */
function confirm(question: string): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    process.stdout.write(question + ' [y/N] ')
    process.stdin.once('data', (chunk) => {
      const answer = String(chunk).trim().toLowerCase()
      resolveAnswer(answer === 'y' || answer === 'yes')
    })
  })
}

async function doctor(): Promise<number> {
  const anchor = installationAnchor()
  const paths = resolvePaths(anchor)
  let failures = 0
  const check = (ok: boolean, line: string): void => {
    console.log((ok ? 'ok   ' : 'FAIL ') + line)
    if (!ok) failures += 1
  }
  const major = Number(process.versions.node.split('.')[0])
  check(major >= 22, 'Node ' + process.versions.node + ' (needs 22 or newer)')
  check(existsSync(join(paths.distributionDirectory, 'package.json')), 'Plus distribution at ' + paths.distributionDirectory)
  check(existsSync(join(paths.profileDirectory, 'package.json')), 'profile at ' + paths.profileDirectory + ' (dsh-plus start creates it)')
  const free = await portAvailable(DEFAULT_PORT)
  check(true, 'port ' + String(DEFAULT_PORT) + (free ? ' is free' : ' is in use; start will choose the next free one'))
  console.log(failures === 0 ? 'No problems found.' : String(failures) + ' problem(s) found.')
  return failures === 0 ? 0 : 1
}

const USAGE = [
  'Usage: dsh-plus <command> [options]',
  '',
  'Commands:',
  '  start     start the server (first run creates the profile)',
  '  stop      stop the server',
  '  status    report whether the server is running',
  '  update    move to a newer distribution release',
  '  doctor    check this installation',
  '',
  'start options:',
  '  --port <n>     port to prefer (default ' + String(DEFAULT_PORT) + '; a taken port moves to the next free one)',
  '  --host <h>     interface to bind (default 127.0.0.1)',
  '  --no-open      do not open a browser',
  '  --foreground   run in this terminal instead of in the background',
  '',
  'update options:',
  '  --check        report the available release without installing it',
  '  --yes          install without asking',
].join('\n')

/**
 * Dispatch one command line.
 *
 * @param argv - arguments after the executable and script name.
 * @returns the process exit code.
 */
export async function runStandaloneCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE)
    return 0
  }
  if (command === 'start') return await start(rest)
  if (command === 'stop') return stop()
  if (command === 'status') return status()
  if (command === 'update') return await update(rest)
  if (command === 'doctor') return doctor()
  console.error('unknown command: ' + command)
  console.error(USAGE)
  return 1
}
