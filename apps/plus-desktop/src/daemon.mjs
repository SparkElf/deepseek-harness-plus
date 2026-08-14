import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { connect } from 'node:net'

const CONNECT_TIMEOUT_MS = 30_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isConnectionError(error) {
  return error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT' || error?.code === 'ECONNRESET'
}

function sendCommand(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let input = ''
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      socket.destroy()
      callback(value)
    }
    const timer = setTimeout(() => finish(reject, new Error('runtime supervisor connection timed out')), CONNECT_TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      input += chunk
      const index = input.indexOf(String.fromCharCode(10))
      if (index < 0) return
      clearTimeout(timer)
      try {
        const response = JSON.parse(input.slice(0, index))
        if (response.ok) finish(resolve, response.value)
        else finish(reject, new Error(response.error))
      } catch (error) {
        finish(reject, error)
      }
    })
    socket.once('error', (error) => { clearTimeout(timer); finish(reject, error) })
    socket.once('close', () => {
      clearTimeout(timer)
      if (!settled) finish(reject, new Error('runtime supervisor closed the control socket'))
    })
    socket.write(JSON.stringify({ command }) + String.fromCharCode(10))
  })
}

export class HarnessDaemon {
  constructor(onStatus, supervisorPath) {
    this.onStatus = onStatus
    this.supervisorPath = supervisorPath
    this.config = undefined
    this.running = false
    this.supervisorStarting = undefined
  }

  configure(config) {
    this.config = config
  }

  status() {
    return this.running ? 'running' : 'stopped'
  }

  async ensureSupervisor() {
    if (this.config === undefined) throw new Error('Install DeepSeek Harness Plus before starting the local service.')
    const { supervisorSocketPath, supervisorManifestPath } = this.config
    if (!supervisorSocketPath || !supervisorManifestPath) throw new Error('The runtime is missing supervisor paths; repair the installation.')
    try {
      await sendCommand(supervisorSocketPath, 'status')
      return
    } catch (error) {
      if (!isConnectionError(error)) throw error
    }
    if (this.supervisorStarting !== undefined) return this.supervisorStarting
    this.supervisorStarting = (async () => {
      await mkdir(dirname(supervisorManifestPath), { recursive: true })
      await writeFile(supervisorManifestPath, JSON.stringify(this.config, null, 2) + String.fromCharCode(10), { mode: 0o600 })
      const child = spawn(process.execPath, [this.supervisorPath, '--manifest', supervisorManifestPath, '--socket', supervisorSocketPath], {
        cwd: this.config.installPath,
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      const deadline = Date.now() + CONNECT_TIMEOUT_MS
      let lastError = undefined
      while (Date.now() < deadline) {
        try {
          await sendCommand(supervisorSocketPath, 'status')
          return
        } catch (error) {
          lastError = error
          await new Promise(resolve => setTimeout(resolve, 250))
        }
      }
      throw new Error('runtime supervisor did not start: ' + errorMessage(lastError))
    })()
    try { await this.supervisorStarting } finally { this.supervisorStarting = undefined }
  }

  async command(command) {
    await this.ensureSupervisor()
    return sendCommand(this.config.supervisorSocketPath, command)
  }

  async start() {
    this.onStatus({ state: 'starting', message: 'Runtime supervisor is starting the local service.' })
    const result = await this.command('start')
    this.running = result.state === 'running'
    this.onStatus({ state: this.running ? 'running' : 'stopped', message: this.running ? 'Local service is running.' : 'Local service is stopped.' })
  }

  async stop() {
    if (this.config === undefined) return
    try { await this.command('stop') } catch (error) { if (!isConnectionError(error)) throw error }
    this.running = false
    this.onStatus({ state: 'stopped', message: 'Local service stopped.' })
  }

  async restart(rebuild = false) {
    this.onStatus({ state: 'starting', message: rebuild ? 'Building and restarting the local service.' : 'Restarting the local service.' })
    const result = await this.command(rebuild ? 'rebuild-and-restart' : 'restart')
    this.running = result.state === 'running'
    this.onStatus({ state: this.running ? 'running' : 'stopped', message: this.running ? 'Local service is running.' : 'Local service is stopped.' })
  }
}
