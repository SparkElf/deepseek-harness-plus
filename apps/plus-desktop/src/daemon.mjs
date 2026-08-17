import { resolveLocale, translate } from '../progress/locales.js'
import { TargetRuntime } from './target-runtime.mjs'

const CONNECT_TIMEOUT_MS = 30_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isConnectionError(error) {
  return error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT' || error?.code === 'ECONNRESET' || errorMessage(error).includes('[supervisor] connection failed')
}

/** Electron tray client for the detached local runtime Supervisor. */
export class HarnessDaemon {
  constructor(onStatus, supervisorPath, nativeSupervisorLauncher) {
    this.onStatus = onStatus
    this.supervisorPath = supervisorPath
    this.nativeSupervisorLauncher = nativeSupervisorLauncher
    this.config = undefined
    this.targetRuntime = undefined
    this.running = false
    this.supervisorStarting = undefined
  }

  configure(config) {
    this.config = config
    this.targetRuntime = new TargetRuntime(config.target)
  }

  status() {
    return this.running ? 'running' : 'stopped'
  }

  /** 在已选 Windows 或 WSL 目标内确保唯一 Supervisor 正在监听。 */
  async ensureSupervisor() {
    if (this.config === undefined) throw new Error('Install DeepSeek Harness Plus before starting the local service.')
    try {
      await this.targetRuntime.sendSupervisorCommand(this.config, 'status')
      return
    } catch (error) {
      if (!isConnectionError(error)) throw error
    }
    if (this.supervisorStarting !== undefined) return this.supervisorStarting
    this.supervisorStarting = (async () => {
      await this.targetRuntime.writeText(this.config.supervisorManifestPath, JSON.stringify(this.config, null, 2) + String.fromCharCode(10))
      await this.targetRuntime.startSupervisor(this.config, this.supervisorPath, this.nativeSupervisorLauncher)
      const deadline = Date.now() + CONNECT_TIMEOUT_MS
      let lastError
      while (Date.now() < deadline) {
        try {
          await this.targetRuntime.sendSupervisorCommand(this.config, 'status')
          return
        } catch (error) {
          lastError = error
          await new Promise(resolve => setTimeout(resolve, 250))
        }
      }
      const message = this.config.locale === 'zh'
        ? `runtime supervisor 未能在端口 ${String(this.config.supervisorPort)} 启动：${errorMessage(lastError)}`
        : `runtime supervisor did not start on port ${String(this.config.supervisorPort)}: ${errorMessage(lastError)}`
      throw new Error(message)
    })()
    try { await this.supervisorStarting } finally { this.supervisorStarting = undefined }
  }

  localizedMessage(key) {
    return translate(resolveLocale(this.config.locale), key)
  }

  /** 向目标环境内的 Supervisor 发送动作，并把阶段反馈转给托盘。 */
  async command(command) {
    await this.ensureSupervisor()
    return this.targetRuntime.sendSupervisorCommand(this.config, command, phase => {
      this.onStatus({ state: 'starting', message: translate(resolveLocale(this.config.locale), 'phase.' + phase.key, phase.values) })
    })
  }

  async snapshot() {
    const result = await this.command('status')
    this.running = result.state === 'running'
    return result
  }

  async start() {
    this.onStatus({ state: 'starting', message: this.localizedMessage('tray.starting') })
    const result = await this.command('start')
    this.running = result.state === 'running'
    this.onStatus({ state: this.running ? 'running' : 'stopped', message: this.localizedMessage(this.running ? 'tray.running' : 'tray.stopped') })
  }

  async stop() {
    if (this.config === undefined) return
    try { await this.command('stop') } catch (error) { if (!isConnectionError(error)) throw error }
    this.running = false
    this.onStatus({ state: 'stopped', message: this.localizedMessage('tray.stopped') })
  }

  async restart(rebuild = false) {
    this.onStatus({ state: 'starting', message: this.localizedMessage(rebuild ? 'tray.rebuilding' : 'tray.restarting') })
    const result = await this.command(rebuild ? 'rebuild-and-restart' : 'restart')
    this.running = result.state === 'running'
    this.onStatus({ state: this.running ? 'running' : 'stopped', message: this.localizedMessage(this.running ? 'tray.running' : 'tray.stopped') })
  }
}
