import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

function environmentFrom(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf('=')
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : []
  }))
}

export class HarnessDaemon {
  constructor(onStatus) {
    this.onStatus = onStatus
    this.process = undefined
    this.config = undefined
  }

  configure(config) {
    this.config = config
  }

  status() {
    return this.process === undefined ? 'stopped' : 'running'
  }

  async start() {
    if (this.process !== undefined) return
    if (this.config === undefined) throw new Error('Complete setup before starting the local service.')
    const secrets = environmentFrom(await readFile(this.config.envPath, 'utf8'))
    const child = spawn('pnpm', ['dsh', 'web', '--port', String(this.config.port)], {
      cwd: this.config.installPath,
      env: { ...process.env, ...secrets, DSH_HOME: this.config.dshHome, DSH_TOOLS_MODE: this.config.mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.process = child
    this.onStatus({ state: 'running', message: 'Local service is starting.' })
    await new Promise((resolve, reject) => {
      let ready = false
      const timeout = setTimeout(() => {
        if (ready) return
        child.kill('SIGTERM')
        this.process = undefined
        reject(new Error('The local service did not report a listening URL within 30 seconds.'))
      }, 30_000)
      const fail = (error) => {
        if (ready) return
        clearTimeout(timeout)
        this.process = undefined
        reject(error)
      }
      const forward = (chunk) => {
        const message = chunk.toString().trim()
        if (message) this.onStatus({ state: 'running', message })
        if (!ready && /https?:\/\//.test(message)) {
          ready = true
          clearTimeout(timeout)
          resolve()
        }
      }
      child.stdout.on('data', forward)
      child.stderr.on('data', forward)
      child.once('error', fail)
      child.once('exit', (code, signal) => {
        this.process = undefined
        if (!ready) {
          fail(new Error('The local service exited before listening: ' + (signal ?? 'exit code ' + String(code)) + '.'))
          return
        }
        this.onStatus({ state: code === 0 ? 'stopped' : 'error', message: code === 0 ? 'Local service stopped.' : 'Local service stopped with ' + (signal ?? 'exit code ' + String(code)) + '.' })
      })
    })
  }

  stop() {
    if (this.process === undefined) return
    this.process.kill('SIGTERM')
  }
}
