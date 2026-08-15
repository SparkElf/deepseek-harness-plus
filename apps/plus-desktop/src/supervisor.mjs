import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { chmod, mkdir, readFile, unlink } from 'node:fs/promises'
import { closeSync, openSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeSupervisorManifest } from './supervisor-manifest.mjs'

const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 10_000
const BUILD_TIMEOUT_MS = 15 * 60_000
const PORT_PROBE_TIMEOUT_MS = 1_000
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

function run(command, args, cwd, env, timeoutMs, onOutput, onSpawn, detached = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'] })
    onSpawn?.(child)
    let output = ''
    const capture = (chunk) => {
      const text = chunk.toString()
      output = (output + text).slice(-16_384)
      onOutput?.(text.trim())
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    let timeoutError
    const timer = setTimeout(() => {
      timeoutError = new Error(command + ' timed out after ' + String(timeoutMs) + 'ms')
      if (detached && process.platform !== 'win32' && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      } else child.kill('SIGTERM')
    }, timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (timeoutError !== undefined) reject(timeoutError)
      else if (code === 0) resolve(output)
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
    this.recordedWebPid = undefined
    this.watcher = undefined
    this.buildProcess = undefined
    this.server = undefined
    this.logHandle = undefined
    this.phase = { key: 'idle' }
    this.source = undefined
    this.activeCommand = undefined
    this.sockets = new Set()
    this.progressListeners = new Set()
  }

  async load() {
    this.manifest = JSON.parse(await readFile(this.manifestPath, 'utf8'))
    if (!this.manifest.installPath || !this.manifest.dshHome || !this.manifest.port) {
      throw new Error('supervisor manifest needs installPath, dshHome, and port')
    }
    this.recordedWebPid = this.manifest.webPid
    await this.openLog()
    await this.refreshSource()
  }

  environment() {
    return {
      ...process.env,
      DSH_HOME: this.manifest.dshHome,
      DSH_TOOLS_MODE: this.manifest.mode ?? 'code',
      DSH_SUPERVISOR: '1',
    }
  }

  /** 构建输出会持久化，因此构建进程不接收环境凭据。 */
  buildEnvironment() {
    return Object.fromEntries(Object.entries(this.environment()).filter(([name]) => !/(KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
  }

  async refreshSource() {
    this.source = await sourceStatus(this.manifest.installPath)
  }

  writeStatus() {
    const content = JSON.stringify({
      ...this.manifest,
      ...this.source,
      state: this.web === undefined ? 'stopped' : 'running',
      webPid: this.web?.pid ?? this.recordedWebPid,
      watcherPid: this.watcher?.pid,
      phase: this.phase,
    }, null, 2) + String.fromCharCode(10)
    writeSupervisorManifest(this.manifestPath, content)
  }

  announce(key, values = {}) {
    this.phase = { key, values }
    writeSync(this.logHandle, '[phase] ' + new Date().toISOString() + ' ' + JSON.stringify(this.phase) + String.fromCharCode(10))
    for (const listener of this.progressListeners) {
      try { listener(this.phase) }
      catch (error) { console.error('[supervisor] progress listener failed', error) }
    }
    this.writeStatus()
  }

  async openLog() {
    const logPath = join(this.manifest.dshHome, 'supervisor', 'runtime.log')
    await mkdir(dirname(logPath), { recursive: true })
    if (this.logHandle === undefined) this.logHandle = openSync(logPath, 'a')
    return this.logHandle
  }

  async portOpen() {
    return await new Promise((resolve) => {
      const probe = connect({ host: '127.0.0.1', port: this.manifest.port })
      const settle = open => { probe.destroy(); resolve(open) }
      probe.setTimeout(PORT_PROBE_TIMEOUT_MS)
      probe.once('connect', () => settle(true))
      probe.once('error', () => settle(false))
      probe.once('timeout', () => settle(false))
    })
  }

  async portPids() {
    const args = process.platform === 'win32'
      ? ['-ano', '-p', 'tcp']
      : process.platform === 'darwin'
        ? ['-nP', '-iTCP:' + String(this.manifest.port), '-sTCP:LISTEN', '-t']
        : ['-ltnp']
    const command = process.platform === 'win32' ? 'netstat' : process.platform === 'darwin' ? 'lsof' : 'ss'
    let output
    try { output = await run(command, args, this.manifest.installPath, this.environment(), 10_000) }
    catch (error) {
      console.error('[supervisor] configured port owner lookup failed', error)
      return []
    }
    if (process.platform === 'darwin') return output.split(/\s+/u).map(value => Number(value)).filter(Number.isInteger)
    if (process.platform === 'win32') {
      return output.split(String.fromCharCode(10))
        .filter(line => line.includes('LISTENING') && line.includes(':' + String(this.manifest.port)))
        .map(line => Number(line.trim().split(/\s+/u).at(-1)))
        .filter(Number.isInteger)
    }
    const pids = []
    for (const line of output.split(String.fromCharCode(10))) {
      if (!line.includes('LISTEN') || !line.includes(':' + String(this.manifest.port))) continue
      for (const match of line.matchAll(/pid=(\d+)/gu)) pids.push(Number(match[1]))
    }
    return [...new Set(pids)]
  }

  /** 验证端口 listener 属于记录的 Web PID 或其 Unix process group。 */
  async ownsConfiguredPort(pids, knownPid) {
    if (!Number.isInteger(knownPid)) return false
    if (pids.includes(knownPid)) return true
    if (process.platform === 'win32') return false
    for (const pid of pids) {
      try {
        const group = Number((await run('ps', ['-o', 'pgid=', '-p', String(pid)], this.manifest.installPath, this.environment(), 10_000)).trim())
        if (group === knownPid) return true
      } catch (error) {
        console.error('[supervisor] port process-group lookup failed', error)
      }
    }
    return false
  }

  /** 接管配置端口上的旧进程；调用方随后负责重新构建并启动 Web。 */
  async releaseExternalPort() {
    if (!(await this.portOpen())) return
    this.announce('takeover.locating')
    const pids = (await this.portPids()).filter(pid => pid !== process.pid)
    if (pids.length === 0) throw new Error('configured port is in use but its owner could not be identified')
    const knownPid = this.web?.pid ?? this.recordedWebPid
    const ownsPort = await this.ownsConfiguredPort(pids, knownPid)
    if (!ownsPort && this.manifest.allowPortTakeover !== true) {
      throw new Error('configured port belongs to an unrecognized process; set allowPortTakeover explicitly to take it over')
    }
    const targetPids = ownsPort ? [knownPid] : pids
    this.announce('takeover.stopping', { pids: targetPids.join(', ') })
    if (ownsPort && process.platform !== 'win32') {
      try { process.kill(-knownPid, 'SIGTERM') }
      catch (error) { if (error?.code !== 'ESRCH') throw error }
    } else for (const pid of targetPids) {
      if (process.platform === 'win32') await run('taskkill', ['/PID', String(pid), '/T'], this.manifest.installPath, this.environment(), STOP_TIMEOUT_MS)
      else {
        try { process.kill(pid, 'SIGTERM') }
        catch (error) { if (error?.code !== 'ESRCH') throw error }
      }
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS
    while (Date.now() < deadline && await this.portOpen()) await new Promise(resolve => setTimeout(resolve, 200))
    if (await this.portOpen()) {
      this.announce('takeover.forcing')
      if (ownsPort && process.platform !== 'win32') {
        try { process.kill(-knownPid, 'SIGKILL') }
        catch (error) { if (error?.code !== 'ESRCH') throw error }
      } else for (const pid of targetPids) {
        if (process.platform === 'win32') await run('taskkill', ['/PID', String(pid), '/T', '/F'], this.manifest.installPath, this.environment(), STOP_TIMEOUT_MS)
        else {
          try { process.kill(pid, 'SIGKILL') }
          catch (error) { if (error?.code !== 'ESRCH') throw error }
        }
      }
      const forcedDeadline = Date.now() + STOP_TIMEOUT_MS
      while (Date.now() < forcedDeadline && await this.portOpen()) await new Promise(resolve => setTimeout(resolve, 200))
      if (await this.portOpen()) throw new Error('configured port owner did not stop')
    }
    this.recordedWebPid = undefined
    this.announce('takeover.released')
  }

  async startWeb() {
    if (this.web !== undefined) return
    this.announce('start.checkingPort')
    await this.releaseExternalPort()
    this.announce('start.launchingWeb')
    const log = await this.openLog()
    this.recordedWebPid = undefined
    const child = spawn('pnpm', ['dsh', 'web', '--host', '127.0.0.1', '--port', String(this.manifest.port)], {
      cwd: this.manifest.installPath,
      env: this.environment(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', log, log],
    })
    this.web = child
    child.once('exit', () => {
      if (this.web !== child) return
      this.web = undefined
      this.recordedWebPid = undefined
      this.writeStatus()
    })
    await this.waitForPort(child)
    this.announce('ready.listening', { port: this.manifest.port })
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
    this.announce('watcher.starting')
    const log = await this.openLog()
    const watcher = spawn('pnpm', ['run', 'dev:web'], {
      cwd: this.manifest.installPath,
      env: this.environment(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', log, log],
    })
    this.watcher = watcher
    watcher.once('exit', () => {
      if (this.watcher !== watcher) return
      this.watcher = undefined
      this.writeStatus()
    })
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
      await waitForExit(child, STOP_TIMEOUT_MS)
    }
  }

  async stop() {
    const watcher = this.watcher
    this.watcher = undefined
    if (watcher !== undefined) await this.stopProcess(watcher)
    const web = this.web
    this.web = undefined
    this.recordedWebPid = undefined
    if (web !== undefined) await this.stopProcess(web)
    this.writeStatus()
  }

  /** 在 manifest 指定的 worktree 中构建，并把构建输出写入持久日志。 */
  async build() {
    const log = await this.openLog()
    let lastLine = ''
    this.announce('build.starting')
    try {
      await run('pnpm', ['run', 'build'], this.manifest.installPath, this.buildEnvironment(), BUILD_TIMEOUT_MS, text => {
        writeSync(log, text + String.fromCharCode(10))
        const line = text.split(String.fromCharCode(10)).map(value => value.trim()).filter(Boolean).at(-1)
        if (line && line !== lastLine) {
          lastLine = line
          this.announce('build.output', { line: line.slice(-240) })
        }
      }, child => { this.buildProcess = child }, true)
    } finally {
      this.buildProcess = undefined
    }
    this.announce('build.complete')
    await this.refreshSource()
    this.writeStatus()
  }

  async restart(rebuild) {
    const wasRunning = this.web !== undefined || await this.portOpen()
    this.announce(rebuild ? 'restart.preparingBuild' : 'restart.preparing')
    await this.stop()
    if (rebuild) await this.build()
    if (wasRunning || rebuild) await this.startWeb()
    this.announce('restart.complete')
    this.writeStatus()
  }

  async status() {
    await this.refreshSource()
    this.writeStatus()
    return {
      state: this.web === undefined ? 'stopped' : 'running',
      sourcePath: this.manifest.installPath,
      dshHome: this.manifest.dshHome,
      port: this.manifest.port,
      mode: this.manifest.mode ?? 'code',
      webPid: this.web?.pid ?? this.recordedWebPid,
      watcherPid: this.watcher?.pid,
      phase: this.phase,
      ...this.source,
    }
  }

  async command(name) {
    if (name === 'status') return this.status()
    if (this.activeCommand !== undefined) throw new Error('Supervisor command already running: ' + this.activeCommand)
    this.activeCommand = name
    try {
      if (name === 'start') await this.startWeb()
      else if (name === 'stop') await this.stop()
      else if (name === 'restart') await this.restart(false)
      else if (name === 'rebuild-and-restart') await this.restart(true)
      else if (name === 'build') await this.build()
      else if (name === 'start-client-watcher') await this.startWatcher()
      else throw new Error('unknown supervisor command: ' + name)
      return this.status()
    } catch (error) {
      this.announce('failed', { message: errorMessage(error) })
      throw error
    } finally {
      this.activeCommand = undefined
    }
  }

  async listen() {
    await this.load()
    try { await unlink(this.socketPath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    this.server = createServer((socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
      socket.on('error', error => console.error('[supervisor] local client socket error', error))
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
    this.writeStatus()
  }

  /** 通过一个本地 socket 请求传输阶段进度和最终结果。 */
  async handle(socket, request) {
    const receivesProgress = request.command !== 'status'
    const progress = message => {
      if (!socket.destroyed) socket.write(JSON.stringify({ event: 'progress', message }) + String.fromCharCode(10))
    }
    if (receivesProgress) this.progressListeners.add(progress)
    try { socket.write(JSON.stringify({ ok: true, value: await this.command(request.command) }) + String.fromCharCode(10)) }
    catch (error) {
      console.error('[supervisor] command failed', error)
      socket.write(JSON.stringify({ ok: false, error: errorMessage(error) }) + String.fromCharCode(10))
    }
    finally { if (receivesProgress) this.progressListeners.delete(progress) }
  }

  async close() {
    this.progressListeners.clear()
    for (const socket of this.sockets) socket.end()
    this.sockets.clear()
    const build = this.buildProcess
    this.buildProcess = undefined
    if (build !== undefined) await this.stopProcess(build)
    await this.stop()
    if (this.logHandle !== undefined) closeSync(this.logHandle)
    await new Promise(resolve => this.server?.close(() => resolve()))
    try { await unlink(this.socketPath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}

/**
 * 启动独立的本地 Harness runtime Supervisor。
 * @param {string} manifestPath 记录 runtime identity 的 manifest 路径。
 * @param {string} socketPath 本地控制 socket 或 named pipe 名称。
 * @returns {Promise<RuntimeSupervisor>} 已监听控制 endpoint 的 Supervisor。
 */
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
