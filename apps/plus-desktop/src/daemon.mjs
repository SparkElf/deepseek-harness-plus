import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveLocale, translate } from '../progress/locales.js'
import { TargetRuntime } from './target-runtime.mjs'

const execFileAsync = promisify(execFile)

const CONNECT_TIMEOUT_MS = 30_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isConnectionError(error) {
  return error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT' || error?.code === 'ECONNRESET' || errorMessage(error).includes('[supervisor] connection failed')
}

/** 按命令行特征强杀占用 Supervisor 端口的旧实例（兼容不识别 shutdown 的旧版本）。 */
async function killStaleSupervisor(config) {
  const socket = String(config.supervisorSocketPath ?? '')
  try {
    if (process.platform === 'win32') {
      const script = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*supervisor.mjs*\' -and $_.CommandLine -like \'*' + socket + '*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
      await execFileAsync('powershell', ['-NoProfile', '-Command', script], { windowsHide: true })
    } else {
      await execFileAsync('pkill', ['-f', 'supervisor.mjs.*' + socket])
    }
  } catch {
    // 找不到进程或权限不足时由后续启动报错暴露
  }
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
      const status = await this.targetRuntime.sendSupervisorCommand(this.config, 'status')
      // 存活但端口配置不一致的 Supervisor 是旧实例：停掉并等其退出，再由新 manifest 拉起。
      if (status.port === this.config.port && status.supervisorPort === this.config.supervisorPort) return
      try { await this.targetRuntime.sendSupervisorCommand(this.config, 'stop') } catch { /* web 可能已停止 */ }
      try { await this.targetRuntime.sendSupervisorCommand(this.config, 'shutdown') } catch { /* 旧版本可能不识别 shutdown */ }
      const deadline = Date.now() + 5_000
      let alive = true
      while (Date.now() < deadline) {
        try {
          await this.targetRuntime.sendSupervisorCommand(this.config, 'status')
        } catch {
          alive = false
          break
        }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      // 旧版 Supervisor 不识别 shutdown 时按命令行强杀，确保新 manifest 能绑定端口。
      if (alive) {
        await killStaleSupervisor(this.config)
        const killDeadline = Date.now() + 5_000
        while (Date.now() < killDeadline) {
          try {
            await this.targetRuntime.sendSupervisorCommand(this.config, 'status')
          } catch {
            break
          }
          await new Promise(resolve => setTimeout(resolve, 250))
        }
      }
    } catch (error) {
      if (!isConnectionError(error)) throw error
    }
    if (this.supervisorStarting !== undefined) return this.supervisorStarting
    this.supervisorStarting = (async () => {
      await this.targetRuntime.writeText(this.config.supervisorManifestPath, JSON.stringify(this.config, null, 2) + String.fromCharCode(10))
      await this.targetRuntime.writeText(this.config.supervisorStartupErrorPath, '')
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
      const startupDetail = await this.targetRuntime.readText(this.config.supervisorStartupErrorPath)
      const cause = startupDetail.trim() || errorMessage(lastError)
      console.error('[plus-desktop] runtime Supervisor startup failed', cause)
      const message = this.config.locale === 'zh'
        ? `runtime supervisor 未能在端口 ${String(this.config.supervisorPort)} 启动：${cause}`
        : `runtime supervisor did not start on port ${String(this.config.supervisorPort)}: ${cause}`
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
