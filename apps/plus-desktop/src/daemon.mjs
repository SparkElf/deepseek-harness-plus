import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { connect } from 'node:net'
import { resolveLocale, translate } from '../progress/locales.js'
import { readLocalePreference } from './supervisor-locale.mjs'
import { writeSupervisorManifest } from './supervisor-manifest.mjs'

const CONNECT_TIMEOUT_MS = 30_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isConnectionError(error) {
  return error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT' || error?.code === 'ECONNRESET'
}

function sendCommand(socketPath, command, onProgress) {
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
      let index = input.indexOf(String.fromCharCode(10))
      while (index >= 0 && !settled) {
        const line = input.slice(0, index)
        input = input.slice(index + 1)
        try {
          const response = JSON.parse(line)
          if (response.event === 'progress') onProgress?.(response.message)
          else if (response.ok) finish(resolve, response.value)
          else finish(reject, new Error(response.error))
        } catch (error) {
          finish(reject, error)
        }
        index = input.indexOf(String.fromCharCode(10))
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

/** Electron tray client for the detached local runtime Supervisor. */
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
      let previous = {}
      try { previous = JSON.parse(await readFile(supervisorManifestPath, 'utf8')) }
      catch (error) { if (error?.code !== 'ENOENT') throw error }
      writeSupervisorManifest(supervisorManifestPath, JSON.stringify({ ...previous, ...this.config }, null, 2) + String.fromCharCode(10))
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

  async localizedMessage(key) {
    return translate(resolveLocale(await readLocalePreference(this.config.dshHome)), key)
  }

  async command(command) {
    await this.ensureSupervisor()
    const locale = await readLocalePreference(this.config.dshHome)
    return sendCommand(this.config.supervisorSocketPath, command, phase => {
      this.onStatus({ state: 'starting', message: translate(resolveLocale(locale), 'phase.' + phase.key, phase.values) })
    })
  }

  async start() {
    this.onStatus({ state: 'starting', message: await this.localizedMessage('tray.starting') })
    const result = await this.command('start')
    this.running = result.state === 'running'
    this.onStatus({ state: this.running ? 'running' : 'stopped', message: await this.localizedMessage(this.running ? 'tray.running' : 'tray.stopped') })
  }

  async stop() {
    if (this.config === undefined) return
    try { await this.command('stop') } catch (error) { if (!isConnectionError(error)) throw error }
    this.running = false
    this.onStatus({ state: 'stopped', message: await this.localizedMessage('tray.stopped') })
  }

  async restart(rebuild = false) {
    this.onStatus({ state: 'starting', message: await this.localizedMessage(rebuild ? 'tray.rebuilding' : 'tray.restarting') })
    const result = await this.command(rebuild ? 'rebuild-and-restart' : 'restart')
    this.running = result.state === 'running'
    this.onStatus({ state: this.running ? 'running' : 'stopped', message: await this.localizedMessage(this.running ? 'tray.running' : 'tray.stopped') })
  }
}
