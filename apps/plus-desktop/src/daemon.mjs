import { spawn } from 'node:child_process'

export class HarnessDaemon {
  constructor(onStatus) {
    this.onStatus = onStatus
    this.process = undefined
    this.config = undefined
    this.stopRequested = false
  }

  configure(config) {
    this.config = config
  }

  status() {
    return this.process === undefined ? 'stopped' : 'running'
  }

  async start() {
    if (this.process !== undefined) return
    if (this.config === undefined) throw new Error('Install DeepSeek Harness Plus before starting the local service.')
    const child = spawn('pnpm', ['dsh', 'web', '--port', String(this.config.port)], {
      cwd: this.config.installPath,
      env: { ...process.env, DSH_HOME: this.config.dshHome, DSH_TOOLS_MODE: this.config.mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.process = child
    this.stopRequested = false
    this.onStatus({ state: 'starting', message: 'Local service is starting.' })
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
        if (message) this.onStatus({ state: 'starting', message })
        if (!ready && /https?:\/\//.test(message)) {
          ready = true
          clearTimeout(timeout)
          this.onStatus({ state: 'running', message: 'Local service is running.' })
          resolve()
        }
      }
      child.stdout.on('data', forward)
      child.stderr.on('data', forward)
      child.once('error', fail)
      child.once('exit', (code, signal) => {
        this.process = undefined
        const stoppedByUser = this.stopRequested
        this.stopRequested = false
        if (!ready) {
          fail(new Error('The local service exited before listening: ' + (signal ?? 'exit code ' + String(code)) + '.'))
          return
        }
        this.onStatus({ state: code === 0 || stoppedByUser ? 'stopped' : 'error', message: code === 0 || stoppedByUser ? 'Local service stopped.' : 'Local service stopped with ' + (signal ?? 'exit code ' + String(code)) + '.' })
      })
    })
  }

  async stop() {
    if (this.process === undefined) return
    const child = this.process
    if (child.exitCode !== null || child.signalCode !== null) return
    this.stopRequested = true
    await new Promise((resolve) => {
      child.once('exit', resolve)
      if (!child.kill('SIGTERM')) resolve()
    })
  }
}
