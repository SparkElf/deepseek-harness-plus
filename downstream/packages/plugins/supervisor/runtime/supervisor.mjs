/** Out-of-process owner for one materialized Plus Web runtime. */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, writeSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { dirname, join } from 'node:path'
import { decodeProcessOutput } from './process-output-encoding.mjs'
import { readSupervisorManifest, writeSupervisorManifest } from './manifest.mjs'
import { startProgressServer } from './progress-server.mjs'

const RECOVERY_PATH = '/api/plus-supervisor/recovery'

/** How many times a Web child that keeps exiting is restarted before the Supervisor stops trying. */
const MAX_RESPAWN_ATTEMPTS = 5
/** Base delay between respawns, multiplied by the attempt number. */
const RESPAWN_BASE_DELAY_MS = 2000

function pipePath(socketPath) {
  return process.platform === 'win32'
    ? String.fromCharCode(92, 92, 46, 92, 112, 105, 112, 101, 92) + socketPath
    : socketPath
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

class SubprocessFailure extends Error {
  constructor(command, code, signal, output) {
    const outcome = signal === null ? 'exit code ' + String(code) : 'signal ' + signal
    super(output || command + ' failed with ' + outcome)
    this.name = 'SubprocessFailure'
    this.summary = command + ' failed with ' + outcome
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => { child.once('exit', resolve) })
}

function run(spec, environment, onOutput, onSpawn, detached = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: environment,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    onSpawn?.(child)
    const outputChunks = []
    const capture = chunk => {
      outputChunks.push(chunk)
      onOutput?.(decodeProcessOutput(chunk).trim())
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      const output = decodeProcessOutput(Buffer.concat(outputChunks)).slice(-16_384)
      if (code === 0) resolve(output)
      else reject(new SubprocessFailure(spec.command, code, signal, output))
    })
  })
}

async function taskkillTree(spec, environment, pid) {
  await run({ command: 'taskkill', args: ['/PID', String(pid), '/T'], cwd: spec.cwd }, environment)
}

/** 单个process持有完整runtime lifecycle；每条command结算后才接收下一条。 */
class RuntimeSupervisor {
  constructor(manifestPath) {
    this.manifestPath = manifestPath
    this.manifest = undefined
    this.socketPath = undefined
    this.web = undefined
    this.recordedWebPid = undefined
    this.running = false
    this.buildProcess = undefined
    this.server = undefined
    this.progressServer = undefined
    this.logHandle = undefined
    this.phase = { key: 'idle', values: {} }
    this.activeCommand = undefined
    this.sockets = new Set()
    this.progressListeners = new Set()
    this.closing = undefined
    this.respawnAttempts = 0
    this.respawnTimer = undefined
    this.stoppingWeb = false
  }

  async load() {
    this.manifest = await readSupervisorManifest(this.manifestPath)
    this.socketPath = pipePath(this.manifest.socketPath)
    this.recordedWebPid = Number.isInteger(this.manifest.webPid) ? this.manifest.webPid : undefined
    this.running = await this.portOpen()
    await this.openLog()
  }

  environment() {
    return {
      ...process.env,
      DSH_HOME: this.manifest.dshHome,
      DSH_SUPERVISOR: '1',
    }
  }

  writeStatus() {
    const content = JSON.stringify({
      ...this.manifest,
      state: this.running ? 'running' : 'stopped',
      webPid: this.web?.pid ?? this.recordedWebPid,
      phase: this.phase,
    }, null, 2) + String.fromCharCode(10)
    writeSupervisorManifest(this.manifestPath, content)
  }

  announce(key, values = {}) {
    this.phase = { key, values }
    writeSync(this.logHandle, '[phase] ' + new Date().toISOString() + ' ' + JSON.stringify(this.phase) + String.fromCharCode(10))
    for (const listener of this.progressListeners) {
      try { listener(this.phase) } catch (error) {
        console.error('[plus-supervisor] progress listener failed', error)
      }
    }
    this.writeStatus()
  }

  async openLog() {
    const logPath = join(this.manifest.dshHome, 'supervisor', 'runtime.log')
    await mkdir(dirname(logPath), { recursive: true })
    if (this.logHandle === undefined) this.logHandle = openSync(logPath, 'w')
    return this.logHandle
  }

  async portOpen() {
    return await new Promise(resolve => {
      const probe = connect({ host: '127.0.0.1', port: this.manifest.port })
      const settle = open => { probe.destroy(); resolve(open) }
      probe.once('connect', () => settle(true))
      probe.once('error', () => settle(false))
    })
  }

  async portPids() {
    const args = process.platform === 'win32'
      ? ['-ano', '-p', 'tcp']
      : process.platform === 'darwin'
        ? ['-nP', '-iTCP:' + String(this.manifest.port), '-sTCP:LISTEN', '-t']
        : ['-ltnp']
    const command = process.platform === 'win32' ? 'netstat' : process.platform === 'darwin' ? 'lsof' : 'ss'
    const output = await run({ command, args, cwd: this.manifest.runtime.cwd }, this.environment())
    if (process.platform === 'darwin') return output.split(/\s+/u).map(Number).filter(Number.isInteger)
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

  async terminatePids(pids) {
    if (process.platform === 'win32') {
      for (const pid of pids) await taskkillTree(this.manifest.runtime, this.environment(), pid)
      return
    }
    for (const pid of pids) process.kill(pid, 'SIGTERM')
  }

  async releaseExternalPort() {
    if (!(await this.portOpen())) return
    this.announce('takeover.locating')
    const pids = (await this.portPids()).filter(pid => pid !== process.pid)
    if (pids.length === 0) throw new Error('configured port owner could not be identified')
    const targets = pids
    this.announce('takeover.stopping', { pids: targets.join(', ') })
    await this.terminatePids(targets)
    while (await this.portOpen()) await new Promise(resolve => setTimeout(resolve, 200))
    this.recordedWebPid = undefined
    this.announce('takeover.released')
  }

  async waitForPort(child) {
    while (!(await this.portOpen())) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Harness Web exited before listening')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  async waitForRecoveryEntry(child) {
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Harness Web exited before Session recovery became available')
      const response = await fetch('http://127.0.0.1:' + String(this.manifest.port) + RECOVERY_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'capture' }),
      })
      await response.arrayBuffer()
      if (response.ok) return
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  async startWeb() {
    if (this.web !== undefined) return
    this.announce('start.checkingPort')
    await this.releaseExternalPort()
    this.announce('start.launchingWeb')
    const log = await this.openLog()
    const child = spawn(this.manifest.runtime.command, this.manifest.runtime.args, {
      cwd: this.manifest.runtime.cwd,
      env: this.environment(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', log, log],
      windowsHide: true,
    })
    this.web = child
    this.recordedWebPid = child.pid
    child.once('exit', (code, signal) => {
      if (this.web !== child) return
      this.web = undefined
      this.recordedWebPid = undefined
      this.running = false
      // A stop the Supervisor asked for is not a failure, so it neither respawns nor
      // counts an attempt: only an exit the Supervisor did not request means the port
      // went dark while the service is meant to be serving.
      if (this.stoppingWeb || this.closing !== undefined) {
        this.writeStatus()
        return
      }
      const outcome = signal === null ? 'exit code ' + String(code) : 'signal ' + signal
      console.error('[plus-supervisor] Harness Web exited with ' + outcome)
      this.announce('web.exited', { outcome })
      this.scheduleRespawn()
    })
    await this.waitForPort(child)
    await this.waitForRecoveryEntry(child)
    this.running = true
    this.respawnAttempts = 0
    this.announce('ready.listening', { port: this.manifest.port })
  }

  /**
   * Restart the Web child after it exited on its own.
   *
   * The Supervisor owns the port, so nothing else can bring the service back: the
   * systemd unit watches this process, and this process previously only recorded that
   * Web had died. A crash therefore left the service dark until an operator started it.
   */
  async scheduleRespawn() {
    if (this.respawnTimer !== undefined || this.closing !== undefined) return
    this.respawnAttempts += 1
    if (this.respawnAttempts > MAX_RESPAWN_ATTEMPTS) {
      this.announce('web.respawnExhausted', { attempts: this.respawnAttempts - 1 })
      return
    }
    const delay = RESPAWN_BASE_DELAY_MS * this.respawnAttempts
    this.announce('web.respawnScheduled', { attempt: this.respawnAttempts, delayMs: delay })
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined
      void this.startWeb().catch(error => {
        console.error('[plus-supervisor] respawn failed', error)
        this.announce('web.respawnFailed', { message: errorMessage(error) })
        void this.scheduleRespawn()
      })
    }, delay)
    this.respawnTimer.unref?.()
  }

  /** Cancel a pending respawn so a commanded stop is not undone by one. */
  cancelRespawn() {
    if (this.respawnTimer === undefined) return
    clearTimeout(this.respawnTimer)
    this.respawnTimer = undefined
  }

  async stopProcess(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32' && child.pid !== undefined) {
      await taskkillTree(this.manifest.runtime, this.environment(), child.pid)
    } else if (child.pid !== undefined) {
      process.kill(-child.pid, 'SIGTERM')
    }
    await waitForExit(child)
  }

  async stop() {
    // Mark the stop as commanded before the child exits, so the exit handler neither
    // respawns it nor counts a restart attempt against a deliberate stop.
    this.stoppingWeb = true
    this.cancelRespawn()
    try {
      const web = this.web
      if (web !== undefined) await this.stopProcess(web)
      else if (await this.portOpen()) await this.releaseExternalPort()
      if (await this.portOpen()) throw new Error('Harness Web stopped but the configured port remains in use')
      this.web = undefined
      this.recordedWebPid = undefined
      this.running = false
      this.respawnAttempts = 0
      this.writeStatus()
    } finally {
      this.stoppingWeb = false
    }
  }

  async build() {
    const spec = this.manifest.build
    if (spec === undefined) throw new Error('Supervisor manifest does not define a build command')
    const log = await this.openLog()
    let lastLine = ''
    this.announce('build.starting')
    try {
      await run(spec, this.environment(), text => {
        writeSync(log, text + String.fromCharCode(10))
        const line = text.split(String.fromCharCode(10)).map(value => value.trim()).filter(Boolean).at(-1)
        if (line && line !== lastLine) {
          lastLine = line
          this.announce('build.output', { line: line.slice(-240) })
        }
      }, child => { this.buildProcess = child }, true)
    } catch (error) {
      throw new Error('Harness build failed before Web shutdown; runtime remains available', { cause: error })
    } finally {
      this.buildProcess = undefined
    }
    this.announce('build.complete')
  }

  async recoveryRequest(payload) {
    const response = await fetch('http://127.0.0.1:' + String(this.manifest.port) + RECOVERY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const result = await response.json()
    if (!response.ok) throw new Error('Session recovery endpoint returned HTTP ' + String(response.status) + ': ' + String(result.error ?? 'unknown error'))
    return result
  }

  async captureRunningSessions() {
    const result = await this.recoveryRequest({ operation: 'capture' })
    this.announce('restart.sessionsCaptured', { count: result.sessionIds.length })
    return result.sessionIds
  }

  async recoverSessions(sessionIds) {
    if (sessionIds.length === 0) return { recovered: [], failed: [] }
    this.announce('restart.recoveringSessions', { count: sessionIds.length })
    const result = await this.recoveryRequest({ operation: 'recover', sessionIds })
    this.announce('restart.sessionsRecovered', {
      recovered: result.recovered.length,
      failed: result.failed.length,
    })
    return result
  }

  /** build完成后才捕获最终running集合，随后按stop、start、recover顺序完成同一次restart。 */
  /**
   * Adopt the manifest on disk, then restart Web onto whatever it names.
   *
   * The manifest is read once at start and the in-memory copy is what every later
   * operation uses, so a mirror switch that edits the file is invisible to a running
   * Supervisor. This is the command that makes the file authoritative again: it
   * re-reads the runtime block, adopts the new mirror, and restarts Web against it in
   * one operation, with the same Session capture and recovery a restart performs.
   *
   * @returns the status after the new Web is listening.
   */
  async reload() {
    const previousRuntime = this.manifest.runtime
    const runtime = await readSupervisorManifest(this.manifestPath)
    if (typeof runtime.runtime?.args?.[0] !== 'string') {
      throw new Error('Supervisor manifest has no runtime.args[0] to adopt')
    }
    // This process owns its listening socket and progress port for its whole life, so a
    // manifest that moves either one describes a different Supervisor rather than a new
    // runtime for this one. Failing here beats adopting half of it and serving a socket
    // path the file no longer names.
    if (runtime.socketPath !== this.manifest.socketPath) {
      throw new Error('reload cannot move socketPath (' + this.manifest.socketPath + ' -> ' + runtime.socketPath + ')')
    }
    if (runtime.supervisorPort !== this.manifest.supervisorPort) {
      throw new Error('reload cannot move supervisorPort (' + String(this.manifest.supervisorPort) + ' -> ' + String(runtime.supervisorPort) + ')')
    }
    const previousArgs0 = previousRuntime.args[0]
    const nextArgs0 = runtime.runtime.args[0]
    this.announce('reload.adopting', { from: previousArgs0, to: nextArgs0 })
    const wasRunning = this.running || await this.portOpen()
    const sessionIds = wasRunning ? await this.captureRunningSessions() : []
    await this.stop()
    // Adopt the whole manifest so dshHome, port, and the build spec follow the file too.
    this.manifest = runtime
    this.socketPath = pipePath(this.manifest.socketPath)
    this.recordedWebPid = Number.isInteger(this.manifest.webPid) ? this.manifest.webPid : undefined
    await this.startWeb()
    const recovery = await this.recoverSessions(sessionIds)
    this.announce('reload.complete', {
      runtime: nextArgs0,
      recovered: recovery.recovered.length,
      failed: recovery.failed.length,
    })
    return this.status()
  }

  async restart(rebuild) {
    const wasRunning = this.running || await this.portOpen()
    this.announce(rebuild ? 'restart.preparingBuild' : 'restart.preparing')
    if (rebuild) await this.build()
    const sessionIds = wasRunning ? await this.captureRunningSessions() : []
    await this.stop()
    if (wasRunning || rebuild) await this.startWeb()
    const recovery = await this.recoverSessions(sessionIds)
    this.announce('restart.complete', {
      recovered: recovery.recovered.length,
      failed: recovery.failed.length,
    })
    return this.status()
  }

  status() {
    return {
      state: this.running ? 'running' : 'stopped',
      dshHome: this.manifest.dshHome,
      port: this.manifest.port,
      supervisorPort: this.manifest.supervisorPort,
      webPid: this.web?.pid ?? this.recordedWebPid,
      phase: this.phase,
      runtime: this.manifest.runtime,
      buildAvailable: this.manifest.build !== undefined,
    }
  }

  async command(command) {
    if (command === 'status') return this.status()
    if (this.activeCommand !== undefined) throw new Error('Supervisor command already running: ' + this.activeCommand)
    this.activeCommand = command
    try {
      if (command === 'start') await this.startWeb()
      else if (command === 'stop') await this.stop()
      else if (command === 'restart') return await this.restart(false)
      else if (command === 'reload') return await this.reload()
      else if (command === 'rebuild-and-restart') return await this.restart(true)
      else throw new Error('unknown Supervisor command: ' + command)
      return this.status()
    } catch (error) {
      console.error('[plus-supervisor] command failed', error)
      this.announce('failed', { message: error instanceof SubprocessFailure ? error.summary : errorMessage(error) })
      throw error
    } finally {
      this.activeCommand = undefined
    }
  }

  async handle(socket, request) {
    const receivesProgress = request.command !== 'status'
    const progress = message => {
      if (!socket.destroyed) socket.write(JSON.stringify({ event: 'progress', message }) + String.fromCharCode(10))
    }
    if (receivesProgress) this.progressListeners.add(progress)
    try {
      socket.write(JSON.stringify({ ok: true, value: await this.command(request.command) }) + String.fromCharCode(10))
    } catch (error) {
      console.error('[plus-supervisor] local command failed', error)
      socket.write(JSON.stringify({ ok: false, error: errorMessage(error) }) + String.fromCharCode(10))
    } finally {
      if (receivesProgress) this.progressListeners.delete(progress)
    }
  }

  async listen() {
    await this.load()
    if (process.platform !== 'win32' && existsSync(this.socketPath)) await unlink(this.socketPath)
    this.server = createServer(socket => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
      socket.on('error', error => console.error('[plus-supervisor] local socket failed', error))
      let input = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        input += chunk
        const lines = input.split(String.fromCharCode(10))
        input = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() === '') continue
          let request
          try { request = JSON.parse(line) } catch (error) {
            console.error('[plus-supervisor] invalid local command JSON', error)
            socket.end(JSON.stringify({ ok: false, error: 'invalid command JSON' }) + String.fromCharCode(10))
            return
          }
          void this.handle(socket, request)
        }
      })
    })
    await new Promise((resolve, reject) => {
      const listening = () => { this.server.off('error', failed); resolve() }
      const failed = error => { this.server.off('listening', listening); reject(error) }
      this.server.once('listening', listening)
      this.server.once('error', failed)
      this.server.listen(this.socketPath)
    })
    this.writeStatus()
    this.progressServer = await startProgressServer({
      port: this.manifest.supervisorPort,
      manifestPath: this.manifestPath,
      socketPath: this.manifest.socketPath,
      logPath: join(this.manifest.dshHome, 'supervisor', 'runtime.log'),
    })
  }

  close() {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      const progressServer = this.progressServer
      this.progressServer = undefined
      if (progressServer !== undefined) await progressServer.close()
      this.progressListeners.clear()
      for (const socket of this.sockets) socket.end()
      this.sockets.clear()
      const build = this.buildProcess
      this.buildProcess = undefined
      this.cancelRespawn()
      if (build !== undefined) await this.stopProcess(build)
      await this.stop()
      if (this.logHandle !== undefined) closeSync(this.logHandle)
      await new Promise(resolve => this.server?.close(() => resolve()))
      if (process.platform !== 'win32' && existsSync(this.socketPath)) await unlink(this.socketPath)
    })()
    return this.closing
  }
}

/**
 * 启动一个本地Supervisor，并让process signal沿同一个lifecycle owner完成teardown。
 * @param {string} manifestPath - explicit runtime manifest path.
 * @returns {Promise<RuntimeSupervisor>} listening Supervisor owner.
 */
export async function runSupervisor(manifestPath) {
  const supervisor = new RuntimeSupervisor(manifestPath)
  await supervisor.listen()
  if (!supervisor.running) await supervisor.startWeb()
  const close = () => {
    void supervisor.close()
      .catch(error => { console.error('[plus-supervisor] shutdown failed', error) })
      .finally(() => process.exit(0))
  }
  process.once('SIGTERM', close)
  process.once('SIGINT', close)
  return supervisor
}
