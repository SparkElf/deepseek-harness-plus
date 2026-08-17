import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, posix } from 'node:path'
import { decodeProcessOutput } from './process-output-encoding.mjs'

const COMMAND_TIMEOUT_MS = 15 * 60_000
const CONNECT_TIMEOUT_MS = 30_000
const proxyEnvironmentKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
const workspaceRequire = createRequire(import.meta.url)
const bundledPnpmCli = join(dirname(workspaceRequire.resolve('pnpm')), 'bin', 'pnpm.mjs')

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: options.detached ?? false,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: options.detached ? 'ignore' : [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    if (options.detached) {
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve('')
      })
      return
    }
    const chunks = []
    let reportBuffer = ''
    const capture = chunk => {
      chunks.push(chunk)
      reportBuffer += chunk.toString('utf8')
      const lines = reportBuffer.split(/\r?\n/u)
      reportBuffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) options.report?.(line.trim())
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? COMMAND_TIMEOUT_MS)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      const output = decodeProcessOutput(Buffer.concat(chunks))
      if (reportBuffer.trim()) options.report?.(reportBuffer.trim())
      if (code === 0) resolve(output)
      else reject(new Error(output || command + ' failed with exit code ' + String(code)))
    })
    if (options.input !== undefined) child.stdin.end(options.input)
  })
}

function sendNativeCommand(socketPath, command, onProgress) {
  return new Promise((resolve, reject) => {
    const pipe = process.platform === 'win32' ? String.fromCharCode(92, 92, 46, 92, 112, 105, 112, 101, 92) + socketPath : socketPath
    const socket = connect(pipe)
    let input = ''
    let settled = false
    let timer
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      callback(value)
    }
    const armIdleTimer = () => {
      clearTimeout(timer)
      timer = setTimeout(() => finish(reject, new Error('runtime supervisor connection timed out')), CONNECT_TIMEOUT_MS)
    }
    armIdleTimer()
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      armIdleTimer()
      input += chunk
      let index = input.indexOf(String.fromCharCode(10))
      while (index >= 0 && !settled) {
        const line = input.slice(0, index)
        input = input.slice(index + 1)
        const response = JSON.parse(line)
        if (response.event === 'progress') onProgress?.(response.message)
        else if (response.ok) finish(resolve, response.value)
        else finish(reject, new Error(response.error))
        index = input.indexOf(String.fromCharCode(10))
      }
    })
    socket.once('error', error => finish(reject, error))
    socket.once('close', () => { if (!settled) finish(reject, new Error('runtime supervisor closed the control socket')) })
    socket.write(JSON.stringify({ command }) + String.fromCharCode(10))
  })
}

/** 枚举 Windows 当前已安装的 WSL 发行版，供安装向导选择真实运行目标。 */
export async function listWslDistributions() {
  if (process.platform !== 'win32') return []
  const output = await new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', ['--list', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => chunks.push(chunk))
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve(decodeProcessOutput(Buffer.concat(chunks))) : reject(new Error(decodeProcessOutput(Buffer.concat(chunks)))))
  })
  return output.split(/\r?\n/u).map(value => value.trim().replace(/^\*\s*/u, '')).filter(Boolean)
}

/**
 * 统一拥有宿主与 WSL 的路径、进程和 Supervisor 控制差异。
 * 上层只传目标语义，避免安装、升级、修复和托盘分别判断运行环境。
 */
export class TargetRuntime {
  constructor(target) {
    this.target = target
  }

  get isWsl() { return this.target.kind === 'wsl' }

  join(...parts) { return this.isWsl ? posix.join(...parts) : join(...parts) }

  command(command, args, cwd, environment) {
    if (!this.isWsl) return { command, args, cwd }
    const wslArgs = ['--distribution', this.target.distribution]
    if (cwd !== undefined) wslArgs.push('--cd', cwd)
    const proxyAssignments = proxyEnvironmentKeys.flatMap(key => environment?.[key] ? [key + '=' + environment[key]] : [])
    wslArgs.push('--exec', ...(proxyAssignments.length > 0 ? ['env', ...proxyAssignments] : []), command, ...args)
    return { command: 'wsl.exe', args: wslArgs, cwd: undefined }
  }

  /** 在选中的目标系统执行命令，并把真实输出交给安装或维护进度。 */
  run(command, args, cwd, report, options = {}) {
    const invocation = this.command(command, args, cwd, options.env)
    return execute(invocation.command, invocation.args, { ...options, cwd: invocation.cwd, report })
  }

  /** 用 installer 自带的 pnpm 运行 native target；WSL 在发行版内用 Corepack 解析固定包管理器。 */
  runPnpm(args, cwd, report, options = {}) {
    if (this.isWsl) return this.run('corepack', ['pnpm', ...args], cwd, report, options)
    return execute(process.execPath, [bundledPnpmCli, ...args], {
      ...options,
      cwd,
      report,
      env: { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: '1' },
    })
  }

  async installationDirectoryState(path) {
    if (this.isWsl) {
      const result = await this.run('sh', ['-lc', 'if test -L "$1"; then printf linked; elif test ! -e "$1"; then printf empty; elif test ! -d "$1"; then printf foreign; elif test -z "$(ls -A -- "$1")"; then printf empty; elif test -d "$1/.git" && test -d "$1/apps/plus-desktop/src"; then printf harness; else printf foreign; fi', 'sh', path]);
      return result.trim();
    }
    let info
    try { info = await lstat(path) } catch (error) {
      if (error?.code === 'ENOENT') return 'empty'
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return 'linked'
    const entries = await readdir(path)
    if (entries.length === 0) return 'empty'
    try {
      const git = await lstat(join(path, '.git'))
      const appSource = await stat(join(path, 'apps/plus-desktop/src'))
      if ((git.isDirectory() || git.isFile()) && appSource.isDirectory()) return 'harness'
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return 'foreign'
  }

  async fileExists(path) {
    if (this.isWsl) return (await this.run('sh', ['-lc', 'test -e "$1" && printf true || printf false', 'sh', path])).trim() === 'true'
    try { await stat(path); return true } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  async assertEmptyDirectory(path) {
    if (!this.isWsl) {
      await mkdir(path, { recursive: true })
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Choose a real installation directory, not a link.')
      if ((await readdir(path)).length > 0) throw new Error('Choose an empty installation directory.')
      return
    }
    await this.run('sh', ['-lc', 'mkdir -p -- "$1" && test ! -L "$1" && test -z "$(ls -A -- "$1")"', 'sh', path])
  }

  /** 清理本次失败 clone 留下的目标目录，使安装器可以安全重试。 */
  async resetInstallDirectory(path) {
    if (!this.isWsl) {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Installation directory became a link during download.')
      await rm(path, { recursive: true, force: true })
      await mkdir(path, { recursive: true })
      return
    }
    await this.run('sh', ['-lc', 'test ! -L "$1" && rm -rf -- "$1" && mkdir -p -- "$1"', 'sh', path])
  }

  async assertDirectory(path) {
    if (!this.isWsl) {
      if (!(await stat(path)).isDirectory()) throw new Error('The configured installation directory is unavailable.')
      return
    }
    await this.run('test', ['-d', path])
  }

  async makeDirectory(path) {
    if (!this.isWsl) return mkdir(path, { recursive: true })
    await this.run('mkdir', ['-p', path])
  }

  /** 将配置写入目标文件系统；WSL 内容通过 stdin 进入发行版，不经过 Windows 路径转换。 */
  async writeText(path, content) {
    if (!this.isWsl) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, { mode: 0o600 })
      return
    }
    await this.run('sh', ['-lc', 'umask 077; mkdir -p -- "$(dirname -- "$1")"; cat > "$1"; chmod 600 "$1"', 'sh', path], undefined, undefined, { input: content })
  }

  async openPath(shell, path) {
    if (!this.isWsl) return shell.openPath(path)
    const windowsPath = (await this.run('wslpath', ['-w', path])).trim()
    return shell.openPath(windowsPath)
  }

  /** 将文件选择结果限制在选中的 WSL 发行版，并转换为该发行版内路径。 */
  async pathFromDirectoryPicker(path) {
    if (!this.isWsl) return path
    const normalized = path.toLowerCase()
    const roots = [
      ['', '', 'wsl.localhost', this.target.distribution, ''].join('\\').toLowerCase(),
      ['', '', 'wsl$', this.target.distribution, ''].join('\\').toLowerCase(),
    ]
    if (!roots.some(root => normalized.startsWith(root))) throw new Error('Choose a folder inside the selected Linux distribution.')
    return (await this.run('wslpath', ['-u', path])).trim()
  }

  /** 读取目标环境中的 UTF-8 runtime 文本；WSL 读取始终在所选发行版内执行。 */
  async readText(path) {
    if (!this.isWsl) return readFile(path, 'utf8')
    return this.run('cat', [path])
  }

  /** 启动目标环境内的 Supervisor；WSL 进程和其子进程始终留在所选发行版。 */
  async startSupervisor(config, nativeSupervisorPath, nativeSupervisorLauncher) {
    if (!this.isWsl) {
      await nativeSupervisorLauncher(nativeSupervisorPath, ['--manifest', config.supervisorManifestPath, '--socket', config.supervisorSocketPath, '--startup-error', config.supervisorStartupErrorPath], config, { DSH_PNPM_CLI: bundledPnpmCli })
      return
    }
    const supervisorPath = this.join(config.installPath, 'apps/plus-desktop/src/supervisor-bootstrap.mjs')
    await this.run('env', ['DSH_PNPM_COMMAND=corepack', 'node', supervisorPath, '--manifest', config.supervisorManifestPath, '--socket', config.supervisorSocketPath, '--startup-error', config.supervisorStartupErrorPath], config.installPath, undefined, { detached: true })
  }

  /** 通过目标环境自己的 Supervisor client 发送命令，避免 Windows 解释 Linux socket。 */
  async sendSupervisorCommand(config, command, onProgress) {
    if (!this.isWsl) return sendNativeCommand(config.supervisorSocketPath, command, onProgress)
    const clientPath = this.join(config.installPath, 'apps/plus-desktop/src/supervisor-client.mjs')
    const output = await this.run('node', [clientPath, '--socket', config.supervisorSocketPath, command], config.installPath, line => {
      if (!line.startsWith('[supervisor] ')) return
      const match = /^\[supervisor\] (\S+) (.*)$/u.exec(line)
      if (match) onProgress?.({ key: match[1], values: JSON.parse(match[2]) })
    }, { timeoutMs: command === 'status' ? CONNECT_TIMEOUT_MS : COMMAND_TIMEOUT_MS })
    const result = output.split(/\r?\n/u).filter(line => line.startsWith('{')).at(-1)
    if (result === undefined) throw new Error('WSL Supervisor returned no status document')
    return JSON.parse(result)
  }
}
