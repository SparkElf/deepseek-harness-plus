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
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
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
  waitForServer,
  writeState,
} from './standalone-server.ts'
import { STANDALONE_PROFILE, ensureProfile, resolvePaths } from './standalone-profile.ts'

/** Milliseconds a start waits for the server to answer before reporting failure. */
const READY_TIMEOUT_MILLISECONDS = 90_000

interface StartOptions {
  readonly port: number
  readonly host: string
  readonly open: boolean
  readonly foreground: boolean
}

function parseStartOptions(argv: readonly string[]): StartOptions {
  let port = DEFAULT_PORT
  let host = '127.0.0.1'
  let open = true
  let foreground = false
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
    throw new Error('unknown option: ' + token)
  }
  return { port, host, open, foreground }
}

/** The launcher entry this installation must drive. */
function launcherEntry(anchor: string): string {
  return createRequire(anchor).resolve('@deepseek-ai/dsh/lib/bin.js')
}

/** Run the server in this process, inheriting stdio. */
function runForeground(entry: string, port: number, host: string, open: boolean): number {
  const args = [entry, '--profile', STANDALONE_PROFILE, '--port', String(port), '--host', host]
  if (!open) args.push('--no-open')
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  return result.status ?? 1
}

async function start(argv: readonly string[]): Promise<number> {
  const options = parseStartOptions(argv)
  const anchor = join(process.cwd(), 'package.json')
  const paths = resolvePaths(anchor)
  const created = ensureProfile(paths)
  console.log(created
    ? 'Created the ' + STANDALONE_PROFILE + ' profile at ' + paths.profileDirectory
    : 'Using the existing ' + STANDALONE_PROFILE + ' profile')
  const entry = launcherEntry(anchor)
  if (options.foreground) return runForeground(entry, options.port, options.host, options.open)

  const existing = readState(paths.home)
  if (existing !== undefined) {
    console.log('Plus is already running at ' + existing.url)
    console.log('Stop it with: dsh-plus stop')
    return 0
  }

  return startDetached(paths.home, entry, options)
}

async function startDetached(home: string, entry: string, options: StartOptions): Promise<number> {
  const port = await choosePort(options.port, options.host)
  if (port === undefined) {
    console.error('No free port in the range ' + String(options.port) + '-' + String(options.port + 9) + '.')
    console.error('Pass --port with a free port.')
    return 1
  }
  if (port !== options.port) console.log('Port ' + String(options.port) + ' is in use; using ' + String(port) + '.')
  const logPath = join(stateDirectory(home), 'server.log')
  const env = { ...process.env, DSH_HOME: home }
  const args = [entry, '--profile', STANDALONE_PROFILE, '--port', String(port), '--host', options.host, '--no-open']
  const pid = spawnServer({ command: process.execPath, args, env, logPath })
  const url = 'http://' + options.host + ':' + String(port) + '/'
  const ready = await waitForServer(url, READY_TIMEOUT_MILLISECONDS)
  if (!ready) {
    console.error('The server did not answer within ' + String(READY_TIMEOUT_MILLISECONDS / 1000) + 's.')
    console.error('Read ' + logPath + ' for the startup error.')
    if (isRunning(pid)) process.kill(pid, 'SIGTERM')
    return 1
  }
  writeState(home, { pid, port, url })
  console.log('Plus is running at ' + url)
  console.log('Logs: ' + logPath)
  console.log('Stop it with: dsh-plus stop')
  return 0
}

async function stop(): Promise<number> {
  const anchor = join(process.cwd(), 'package.json')
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
  const anchor = join(process.cwd(), 'package.json')
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

async function doctor(): Promise<number> {
  const anchor = join(process.cwd(), 'package.json')
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
  '  doctor    check this installation',
  '',
  'start options:',
  '  --port <n>     port to prefer (default ' + String(DEFAULT_PORT) + '; a taken port moves to the next free one)',
  '  --host <h>     interface to bind (default 127.0.0.1)',
  '  --no-open      do not open a browser',
  '  --foreground   run in this terminal instead of in the background',
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
  if (command === 'doctor') return doctor()
  console.error('unknown command: ' + command)
  console.error(USAGE)
  return 1
}
