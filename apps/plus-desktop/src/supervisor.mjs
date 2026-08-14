import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'

const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 10_000
const BUILD_TIMEOUT_MS = 15 * 60_000
const SOCKET_MODE = 0o600

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    args[key.slice(2)] = argv[index + 1]
    index += 1
  }
  return args
}

function pipePath(socketPath) {
  return process.platform === 'win32' ? String.fromCharCode(92, 92, 46, 92, 112, 105, 112, 101, 92) + socketPath : socketPath
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('supervised process did not stop within ' + String(timeoutMs) + 'ms')), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function run(command, args, cwd, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const capture = (chunk) => { output = (output + chunk.toString()).slice(-16_384) }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(command + ' timed out after ' + String(timeoutMs) + 'ms'))
    }, timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error(output || command + ' exited with ' + (signal ?? String(code))))
    })
  })
}

async function gitValue(cwd, args) {
  try { return (await run('git', args, cwd, process.env, 10_000)).trim() }
  catch { return undefined }
}

async function sourceStatus(cwd) {
  const [branch, revision, dirty] = await Promise.all([
    gitValue(cwd, ['branch', '--show-current']),
    gitValue(cwd, ['rev-parse', '--short', 'HEAD']),
    gitValue(cwd, ['status', '--porcelain']),
  ])
  return { branch, revision, dirty: dirty !== undefined && dirty.length > 0 }
}

class RuntimeSupervisor {
  constructor(manifestPath, socketPath) {
    this.manifestPath = manifestPath
    this.socketPath = pipePath(socketPath)
    this.manifest = undefined
    this.web = undefined
    this.watcher = undefined
    this.server = undefined
    this.logHandle = undefined
  }

  async load() {
    this.manifest = JSON.parse(await readFile(this.manifestPath, 'utf8'))
    if (!this.manifest.installPath || !this.manifest.dshHome || !this.manifest.port) {
      throw new Error('supervisor manifest needs installPath, dshHome, and port')
    }
  }

  environment() {
    return {
      ...process.env,
      DSH_HOME: this.manifest.dshHome,
      DSH_TOOLS_MODE: this.manifest.mode ?? 'code',
      DSH_SUPERVISOR: '1',
    }
  }

  async writeStatus() {
    const status = await sourceStatus(this.manifest.installPath)
    await writeFile(this.manifestPath, JSON.stringify({ ...this.manifest, ...status }, null, 2) + String.fromCharCode(10), { mode: 0o600 })
  }

  async openLog() {
    const logPath = join(this.manifest.dshHome, '..', 'logs', 'supervisor-runtime.log')
    await mkdir(dirname(logPath), { recursive: true })
    if (this.logHandle === undefined) this.logHandle = openSync(logPath, 'a')
    return this.logHandle
  }

  async portOpen() {
    return await new Promise((resolve) => {
      const probe = connect({ host: '127.0.0.1', port: this.manifest.port })
      probe.once('connect', () => { probe.destroy(); resolve(true) })
      probe.once('error', () => { probe.destroy(); resolve(false) })
    })
  }

  async startWeb() {
    if (this.web !== undefined) return
    if (await this.portOpen()) throw new Error('configured port ' + String(this.manifest.port) + ' is already in use')
    const log = await this.openLog()
    const child = spawn('pnpm', ['dsh', 'web', '--host', '127.0.0.1', '--port', String(this.manifest.port)], {
      cwd: this.manifest.installPath,
      env: this.environment(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', log, log],
    })
    this.web = child
    child.once('exit', () => { if (this.web === child) this.web = undefined })
    await this.waitForPort(child)
    if (this.manifest.mode === 'development') await this.startWatcher()
  }

  async waitForPort(child) {
    const started = Date.now()
    while (Date.now() - started < START_TIMEOUT_MS) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Harness web exited before listening')
      if (await this.portOpen()) return
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    await this.stopProcess(child)
    throw new Error('Harness web did not listen within ' + String(START_TIMEOUT_MS) + 'ms')
  }

  async startWatcher() {
    if (this.watcher !== undefined) return
    const log = await this.openLog()
    const watcher = spawn('pnpm', ['run', 'dev:web'], {
      cwd: this.manifest.installPath,
      env: this.environment(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', log, log],
    })
    this.watcher = watcher
    watcher.once('exit', () => { if (this.watcher === watcher) this.watcher = undefined })
  }

  async stopProcess(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform !== 'win32' && child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    } else child.kill('SIGTERM')
    try { await waitForExit(child, STOP_TIMEOUT_MS) }
    catch {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      } else child.kill('SIGKILL')
      await waitForExit(child, STOP_TIMEOUT_MS).catch(() => {})
    }
  }

  async stop() {
    const watcher = this.watcher
    this.watcher = undefined
    if (watcher !== undefined) await this.stopProcess(watcher)
    const web = this.web
    this.web = undefined
    if (web !== undefined) await this.stopProcess(web)
  }

  async build() {
    await run('pnpm', ['run', 'build'], this.manifest.installPath, this.environment(), BUILD_TIMEOUT_MS)
    await this.writeStatus()
  }

  async restart(rebuild) {
    const wasRunning = this.web !== undefined
    if (rebuild) await this.build()
    await this.stop()
    if (wasRunning || rebuild) await this.startWeb()
    await this.writeStatus()
  }

  async status() {
    const source = await sourceStatus(this.manifest.installPath)
    return {
      state: this.web === undefined ? 'stopped' : 'running',
      sourcePath: this.manifest.installPath,
      dshHome: this.manifest.dshHome,
      port: this.manifest.port,
      mode: this.manifest.mode ?? 'code',
      webPid: this.web?.pid,
      watcherPid: this.watcher?.pid,
      ...source,
    }
  }

  async command(name) {
    if (name === 'status') return this.status()
    if (name === 'start') { await this.startWeb(); return this.status() }
    if (name === 'stop') { await this.stop(); return this.status() }
    if (name === 'restart') { await this.restart(false); return this.status() }
    if (name === 'rebuild-and-restart') { await this.restart(true); return this.status() }
    if (name === 'build') { await this.build(); return this.status() }
    if (name === 'start-client-watcher') { await this.startWatcher(); return this.status() }
    throw new Error('unknown supervisor command: ' + name)
  }

  async listen() {
    await this.load()
    try { await unlink(this.socketPath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    this.server = createServer((socket) => {
      let input = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        input += chunk
        const lines = input.split(String.fromCharCode(10))
        input = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          void this.handle(socket, JSON.parse(line))
        }
      })
    })
    this.server.listen(this.socketPath)
    if (process.platform !== 'win32') await chmod(this.socketPath, SOCKET_MODE)
    await this.writeStatus()
  }

  async handle(socket, request) {
    try { socket.write(JSON.stringify({ ok: true, value: await this.command(request.command) }) + String.fromCharCode(10)) }
    catch (error) { socket.write(JSON.stringify({ ok: false, error: errorMessage(error) }) + String.fromCharCode(10)) }
  }

  async close() {
    await this.stop()
    if (this.logHandle !== undefined) closeSync(this.logHandle)
    await new Promise(resolve => this.server?.close(() => resolve()))
    try { await unlink(this.socketPath) } catch {}
  }
}

export async function runSupervisor(manifestPath, socketPath) {
  const supervisor = new RuntimeSupervisor(manifestPath, socketPath)
  await supervisor.listen()
  const close = () => { void supervisor.close().finally(() => process.exit(0)) }
  process.once('SIGTERM', close)
  process.once('SIGINT', close)
  return supervisor
}

if (process.argv[1]?.endsWith('supervisor.mjs')) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.manifest || !args.socket) throw new Error('supervisor requires --manifest and --socket')
  await runSupervisor(args.manifest, args.socket)
}
