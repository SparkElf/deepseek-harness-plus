/**
 * Process lifecycle for one standalone Plus server.
 *
 * A standalone user starts a server and later stops it, so the process outlives the
 * command that started it. This module owns the state that makes that possible: a
 * pid file beside the profile, an availability probe for the port, and the port
 * search that keeps a second instance usable without asking the user to pick one.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'

/** Default port a standalone server binds when the user names none. */
export const DEFAULT_PORT = 3080

/** How many consecutive ports to try before reporting that none is free. */
export const PORT_SEARCH_LIMIT = 10

/** Milliseconds to wait for a stopped server to exit before forcing it. */
export const STOP_GRACE_MILLISECONDS = 10_000

/** Recorded state of the running server. */
export interface ServerState {
  /** Process id of the running server. */
  readonly pid: number
  /** Port the server bound. */
  readonly port: number
  /** URL the browser opens. */
  readonly url: string
}

/** Where one installation keeps its runtime state. */
export function stateDirectory(home: string): string {
  return join(home, 'standalone')
}

function statePath(home: string): string {
  return join(stateDirectory(home), 'server.json')
}

/** Whether a process with this id exists and is signalable. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Read the recorded server state, or undefined when absent or its process is gone. */
export function readState(home: string): ServerState | undefined {
  const path = statePath(home)
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const pid = record.pid
  const port = record.port
  const url = record.url
  if (typeof pid !== 'number' || typeof port !== 'number' || typeof url !== 'string') return undefined
  if (!isRunning(pid)) return undefined
  return { pid, port, url }
}

/** Record the running server, replacing any previous record. */
export function writeState(home: string, state: ServerState): void {
  mkdirSync(stateDirectory(home), { recursive: true })
  writeFileSync(statePath(home), JSON.stringify(state, null, 2) + '\n')
}

/** Remove the recorded state, whether or not a process still matches it. */
export function clearState(home: string): void {
  rmSync(statePath(home), { force: true })
}

/** Whether a TCP port on the loopback interface can be bound. */
export function portAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const probe = createServer()
    probe.once('error', () => { resolveAvailability(false) })
    probe.once('listening', () => { probe.close(() => { resolveAvailability(true) }) })
    probe.listen(port, host)
  })
}

/**
 * The first free port at or after `preferred`, so one occupied port never blocks a
 * start the way a bare bind failure would.
 *
 * @param preferred - port the user asked for, or the default.
 * @returns the chosen port, or undefined when the whole search window is occupied.
 */
export async function choosePort(preferred: number, host = '127.0.0.1'): Promise<number | undefined> {
  for (let offset = 0; offset < PORT_SEARCH_LIMIT; offset += 1) {
    const candidate = preferred + offset
    if (await portAvailable(candidate, host)) return candidate
  }
  return undefined
}

/** Start a detached server process and return its id. */
export function spawnServer(options: {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly logPath: string
}): number {
  mkdirSync(dirname(options.logPath), { recursive: true })
  const output = spawn(options.command, [...options.args], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env,
  })
  const stream = createWriteStream(options.logPath)
  output.stdout?.pipe(stream)
  output.stderr?.pipe(stream)
  output.unref()
  if (output.pid === undefined) throw new Error('the server process did not start')
  return output.pid
}

/**
 * Wait until the server answers, so a start reports success only once the URL works.
 *
 * @param url - URL to poll.
 * @param timeoutMilliseconds - how long to keep polling.
 * @returns whether the server answered within the budget.
 */
export async function waitForServer(url: string, timeoutMilliseconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: 'GET', redirect: 'manual' })
      return true
    } catch {
      await new Promise((resolveDelay) => { setTimeout(resolveDelay, 250) })
    }
  }
  return false
}
