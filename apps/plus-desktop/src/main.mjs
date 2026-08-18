import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray, utilityProcess } from 'electron'
import { appendFile, mkdir, opendir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { parse as parseYaml } from 'yaml'
import { HarnessDaemon } from './daemon.mjs'
import { listWslDistributions, TargetRuntime } from './target-runtime.mjs'
import { releaseSourceRef } from './release-source.mjs'
import { BACKUP_MANIFEST_ENTRY, exportUserBackup, restoreUserBackup, validateUserBackup } from './backup.mjs'

const repository = process.env.DSH_PLUS_INSTALL_REPOSITORY ?? 'https://github.com/SparkElf/deepseek-harness-plus.git'
const installSourceRef = process.env.DSH_PLUS_INSTALL_SOURCE_REF ?? releaseSourceRef
const currentDirectory = dirname(fileURLToPath(import.meta.url))
const supervisorDirectory = currentDirectory.replace(/\.asar([\\/])/u, '.asar.unpacked$1')
const supervisorBootstrapPath = join(supervisorDirectory, 'supervisor-bootstrap.mjs')
const setupPath = () => join(app.getPath('userData'), 'runtime.json')
const nativeSupervisorSocketPath = supervisorPort => process.platform === 'win32' ? 'deepseek-harness-plus-runtime-' + String(supervisorPort) : join(app.getPath('userData'), 'runtime-supervisor-' + String(supervisorPort) + '.sock')
const nativeSupervisorManifestPath = () => join(app.getPath('userData'), 'runtime-supervisor.json')
const nativeSupervisorStartupErrorPath = () => join(app.getPath('userData'), 'runtime-supervisor-startup.error.log')
const defaultCandidatePort = 3081
const defaultSupervisorPort = 3082
const defaultCandidateSupervisorPort = 3083
let tray
let installerWindow
let updatesWindow
let backupWindow
let harnessWindow
let runtime
let busy
let supervisorSnapshot
let candidateAvailable = false
let installerLocale = 'zh'
let trayMenu

const trayMessages = {
  zh: {
    supervisorOffline: 'Supervisor 离线', supervisorOnline: 'Supervisor 在线', harnessRunning: 'Harness 运行中', harnessStopped: 'Harness 已停止', candidateRunning: '测试版 Harness 可用', candidateStopped: '测试版 Harness 未运行',
    openProduction: '打开正式 Harness', openCandidate: '打开测试版 Harness', openSupervisor: '打开 Supervisor',
    start: '启动 Harness', stop: '停止 Harness', rebuild: '构建并重启', install: '安装 Plus…', checkUpdates: '版本管理…',
    upgrade: '升级 Plus', repair: '修复安装', openData: '打开本地数据目录', backup: '备份与恢复…', backupTitle: '备份与恢复', backupImportMessage: '导入备份会用压缩包内的文件覆盖同名用户设置和数据。', backupImportDetail: '导入前会先停止 Harness，成功后自动重新启动。', backupImportConfirm: '导入', backupCancel: '取消', backupNotArchive: '所选压缩包不是 DeepSeek Harness Plus 备份文件。', backupUnsafeArchive: '备份压缩包包含不安全的文件路径，已拒绝导入。', loginItem: '开机自动启动', reconfigure: '重新配置安装…', quit: '退出', quitting: '正在退出…',
    checkingUpdates: '正在检查更新…', updateAvailable: '发现 {{count}} 个新提交。', upToDate: '当前已经是最新版本。',
    updateTitle: 'DeepSeek Harness Plus 更新', targetWindows: 'Windows', targetLinux: 'Linux', targetMacos: 'macOS', targetWsl: 'WSL · {{distribution}}',
  },
  en: {
    supervisorOffline: 'Supervisor offline', supervisorOnline: 'Supervisor online', harnessRunning: 'Harness running', harnessStopped: 'Harness stopped', candidateRunning: 'Candidate Harness available', candidateStopped: 'Candidate Harness not running',
    openProduction: 'Open production Harness', openCandidate: 'Open candidate Harness', openSupervisor: 'Open Supervisor',
    start: 'Start Harness', stop: 'Stop Harness', rebuild: 'Build and restart', install: 'Install Plus…', checkUpdates: 'Manage versions…',
    upgrade: 'Upgrade Plus', repair: 'Repair installation', openData: 'Open local data folder', backup: 'Backup and restore…', backupTitle: 'Backup and restore', backupImportMessage: 'Importing replaces user settings and data files with same-named entries from the archive.', backupImportDetail: 'Harness stops before import and restarts after a successful import.', backupImportConfirm: 'Import', backupCancel: 'Cancel', backupNotArchive: 'The selected archive is not a DeepSeek Harness Plus backup.', backupUnsafeArchive: 'The backup archive contains an unsafe path and was rejected.', loginItem: 'Launch at startup', reconfigure: 'Reconfigure installation…', quit: 'Quit', quitting: 'Quitting…',
    checkingUpdates: 'Checking for updates…', updateAvailable: '{{count}} new commits are available.', upToDate: 'This installation is up to date.',
    updateTitle: 'DeepSeek Harness Plus update', targetWindows: 'Windows', targetLinux: 'Linux', targetMacos: 'macOS', targetWsl: 'WSL · {{distribution}}',
  },
}

function locale() {
  return runtime?.locale === 'en' ? 'en' : 'zh'
}

function trayText(key, values = {}) {
  return trayMessages[locale()][key].replace(/\{\{(\w+)\}\}/gu, (_match, name) => String(values[name] ?? ''))
}

function icon() {
  return nativeImage.createFromPath(join(currentDirectory, '..', 'build', 'icon.png'))
}

const catalogProviders = new Set(['deepseek-official', 'openai', 'anthropic', 'google', 'openrouter', 'groq', 'mistral', 'xai'])

/** 将自定义服务名称转换为 Harness 内部使用的稳定 provider 标识。 */
function customProviderRoute(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  return 'custom-' + (slug || 'provider')
}

/** 返回该安装所选 provider 在 Harness 设置中使用的 route 名称。 */
function providerRoute(form) {
  return form.provider === 'custom' ? customProviderRoute(form.customName) : form.provider
}

/** 为安装器写入的密钥生成符合凭据存储要求的引用名称。 */
function credentialReference(form) {
  return 'DSH_INSTALLER_' + providerRoute(form).toUpperCase().replace(/[^A-Z0-9]/gu, '_') + '_API_KEY'
}

/** 生成 Harness 热加载的模型、provider 和界面设置。 */
function settingsDocument(form) {
  const route = providerRoute(form)
  const credential = credentialReference(form)
  const lines = [
    'locale:',
    '  preference: ' + JSON.stringify(form.locale),
    'ui-theme:',
    '  preference: ' + JSON.stringify(form.theme),
    'agent-default-model:',
    '  provider: ' + JSON.stringify(route),
    '  model: ' + JSON.stringify(form.model),
    ...(form.reasoningEffort ? ['  reasoningEffort: ' + JSON.stringify(form.reasoningEffort)] : []),
  ]
  if (form.provider === 'deepseek-official') {
    lines.push('llm-deepseek:', '  apiKeyEnv: ' + credential)
  } else {
    lines.push('llm-pi-ai:', '  providers:', '    ' + route + ':')
    if (form.provider === 'custom') {
      lines.push(
        '      displayName: ' + JSON.stringify(form.customName),
        '      api: openai-completions',
        '      baseURL: ' + JSON.stringify(form.baseURL),
        '      models:',
        '        - id: ' + JSON.stringify(form.model),
      )
    }
    lines.push('      apiKeyEnv: ' + credential)
  }
  return lines.concat('').join('\n')
}

/** 密钥只写入 Harness 管理的凭据文档，不进入设置或进程环境。 */
function credentialsDocument(form) {
  return credentialReference(form) + ': ' + JSON.stringify(form.apiKey) + '\n'
}

function proxyEnvironment(proxy) {
  if (!proxy) return undefined
  return {
    ...process.env,
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
  }
}

function runtimeFor(form, port) {
  const targetRuntime = new TargetRuntime(form.target)
  const dshHome = targetRuntime.join(form.installPath, '.dsh-plus', 'home')
  const supervisorDirectory = targetRuntime.join(dshHome, 'supervisor')
  return {
    version: 4,
    target: form.target,
    installPath: form.installPath,
    proxy: form.proxy || undefined,
    sourceRef: installSourceRef,
    dshHome,
    port,
    candidatePort: Number(form.candidatePort),
    supervisorPort: Number(form.supervisorPort),
    candidateSupervisorPort: Number(form.candidateSupervisorPort),
    supervisorSocketPath: targetRuntime.isWsl ? targetRuntime.join(supervisorDirectory, 'runtime-supervisor.sock') : nativeSupervisorSocketPath(Number(form.supervisorPort)),
    supervisorManifestPath: targetRuntime.isWsl ? targetRuntime.join(supervisorDirectory, 'runtime-supervisor.json') : nativeSupervisorManifestPath(),
    supervisorStartupErrorPath: targetRuntime.isWsl ? targetRuntime.join(supervisorDirectory, 'runtime-supervisor-startup.error.log') : nativeSupervisorStartupErrorPath(),
    locale: form.locale,
    theme: form.theme,
    mode: 'code',
  }
}

async function saveRuntime(configured) {
  await mkdir(dirname(setupPath()), { recursive: true })
  await writeFile(setupPath(), JSON.stringify(configured, null, 2) + '\n', { mode: 0o600 })
  runtime = configured
  daemon.configure(configured)
}

function sendInstaller(channel, payload) {
  installerWindow?.webContents.send(channel, payload)
}

function openInstaller() {
  // 已安装时也允许打开向导（重新配置/安装后初始化），安装流程以覆盖选项处理既有 runtime。
  if (installerWindow !== undefined) {
    installerWindow.show()
    installerWindow.focus()
    return
  }
  installerWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 760,
    minHeight: 620,
    show: false,
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay: process.platform === 'win32' ? { color: '#232324', symbolColor: '#adb2b8', height: 44 } : false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#f9fafb',
    title: 'DeepSeek Harness Plus',
    webPreferences: {
      preload: join(currentDirectory, 'preload.mjs'),
      contextIsolation: true,
      // The ESM preload must run with Node access; renderer exposure remains limited to the allowlisted bridge above.
      sandbox: false,
    },
  })
  installerWindow.loadFile(join(currentDirectory, '..', 'renderer', 'index.html'))
  installerWindow.once('ready-to-show', () => installerWindow?.show())
  installerWindow.on('closed', () => { installerWindow = undefined })
}

function targetLabel() {
  if (runtime === undefined) return ''
  if (runtime.target.kind === 'wsl') return trayText('targetWsl', { distribution: runtime.target.distribution })
  if (process.platform === 'darwin') return trayText('targetMacos')
  if (process.platform === 'linux') return trayText('targetLinux')
  return trayText('targetWindows')
}

function refreshTray() {
  if (tray === undefined) return
  const installed = runtime !== undefined
  const supervisorOnline = supervisorSnapshot !== undefined
  const running = supervisorSnapshot?.state === 'running'
  const maintenanceBusy = busy !== undefined
  const stateLabel = [supervisorOnline ? trayText('supervisorOnline') : trayText('supervisorOffline'), running ? trayText('harnessRunning') : trayText('harnessStopped'), targetLabel()].filter(Boolean).join(' · ')
  tray.setToolTip('DeepSeek Harness Plus: ' + (busy ?? stateLabel))
  trayMenu = Menu.buildFromTemplate([
    { label: stateLabel, enabled: false },
    { type: 'separator' },
    { label: trayText('openProduction'), enabled: installed && running, click: openProduction },
    { label: candidateAvailable ? trayText('openCandidate') : trayText('candidateStopped'), enabled: installed && candidateAvailable, click: openCandidate },
    { label: trayText('openSupervisor'), enabled: installed, click: () => action(trayText('openSupervisor'), openSupervisor) },
    { type: 'separator' },
    { label: trayText('start'), enabled: installed && !running && !maintenanceBusy, click: () => action(trayText('start'), () => daemon.start()) },
    { label: trayText('stop'), enabled: running && !maintenanceBusy, click: () => action(trayText('stop'), () => daemon.stop()) },
    { label: trayText('rebuild'), enabled: installed && !maintenanceBusy, click: () => action(trayText('rebuild'), () => daemon.restart(true)) },
    { type: 'separator' },
    { label: installed ? trayText('reconfigure') : trayText('install'), enabled: !maintenanceBusy, click: openInstaller },
    { label: trayText('checkUpdates'), enabled: installed && !maintenanceBusy, click: () => checkUpdates() },
    { label: trayText('repair'), enabled: installed && !maintenanceBusy, click: () => repair() },
    { label: trayText('openData'), enabled: installed && !maintenanceBusy, click: openDataFolder },
    { label: trayText('backup'), enabled: installed && !maintenanceBusy, click: openBackupWindow },
    { label: trayText('loginItem'), type: 'checkbox', checked: loginItemEnabled(), click: item => toggleLoginItem(item.checked) },
    { type: 'separator' },
    { label: trayText('quit'), click: () => { void quitApp() } },
  ])
  tray.setContextMenu(trayMenu)
}

function candidateRuntimeIsAvailable() {
  return new Promise(resolve => {
    const probe = request({ host: '127.0.0.1', port: runtime?.candidateSupervisorPort ?? defaultCandidateSupervisorPort, path: '/api/status', method: 'GET', timeout: 500 }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.once('end', () => {
        try {
          const snapshot = JSON.parse(body)
          resolve(response.statusCode === 200 && snapshot.runtime?.port === (runtime?.candidatePort ?? defaultCandidatePort) && snapshot.runtime?.state === 'running')
        }
        catch (error) { console.info('[plus-desktop] candidate status response was not readable', error); resolve(false) }
      })
    })
    probe.once('error', () => resolve(false))
    probe.once('timeout', () => { probe.destroy(); resolve(false) })
    probe.end()
  })
}

async function syncSupervisorStatus() {
  if (runtime === undefined) {
    supervisorSnapshot = undefined
    refreshTray()
    return
  }
  supervisorSnapshot = await daemon.snapshot()
  candidateAvailable = await candidateRuntimeIsAvailable()
  refreshTray()
}

/** NSIS 安装完成标记文件名：安装器写入，应用启动时消费并弹出安装向导。 */
const SETUP_MARKER_FILENAME = 'run-initial-setup'

/** 消费安装完成标记：存在则删除并返回 true，触发安装向导弹出。 */
function consumeSetupMarker() {
  const marker = join(dirname(app.getPath('exe')), SETUP_MARKER_FILENAME)
  if (!existsSync(marker)) return false
  rmSync(marker, { force: true })
  return true
}

/** XDG autostart 条目路径：Linux 桌面经 .desktop 文件控制开机自启动。 */
const LINUX_AUTOSTART_PATH = join(homedir(), '.config', 'autostart', 'deepseek-harness-plus.desktop')

/**
 * 开机自启动当前是否开启。Windows（含 WSL 目标——应用本体运行在 Windows）
 * 读 Electron 登录项（注册表 Run 项）；Linux 读 XDG autostart 条目。
 */
function loginItemEnabled() {
  if (process.platform === 'linux') return existsSync(LINUX_AUTOSTART_PATH)
  return app.getLoginItemSettings().openAtLogin
}

/** 按平台写入或移除开机自启动项，并刷新托盘勾选状态。 */
function toggleLoginItem(openAtLogin) {
  if (process.platform === 'linux') {
    if (openAtLogin) {
      mkdirSync(dirname(LINUX_AUTOSTART_PATH), { recursive: true })
      writeFileSync(LINUX_AUTOSTART_PATH, '[Desktop Entry]\nType=Application\nName=DeepSeek Harness Plus\nExec=' + app.getPath('exe') + '\n')
    } else {
      rmSync(LINUX_AUTOSTART_PATH, { force: true })
    }
  } else {
    app.setLoginItemSettings({ openAtLogin })
  }
  refreshTray()
}

/** 停止 runtime 的退出宽限：超时或失败都不再阻塞退出本身。 */
const QUIT_STOP_BUDGET_MS = 8_000

/**
 * 托盘退出：先以托盘提示"正在退出"并禁用菜单，限时尽力停止 runtime，
 * 停止失败或超时也照常退出——退出手势永远生效，且不再弹错误框。
 */
async function quitApp() {
  busy = trayText('quitting')
  refreshTray()
  const budget = new Promise(resolve => setTimeout(resolve, QUIT_STOP_BUDGET_MS))
  try {
    await Promise.race([daemon.stop(), budget])
  } catch (error) {
    console.error('[plus-desktop] runtime stop failed during quit', error)
  }
  app.quit()
}

async function action(label, work) {
  busy = label
  refreshTray()
  try {
    await work()
    if (runtime !== undefined) await syncSupervisorStatus()
  } catch (error) {
    console.error('[plus-desktop] action failed', error)
    dialog.showErrorBox('DeepSeek Harness Plus', error instanceof Error ? error.message : String(error))
  } finally {
    busy = undefined
    refreshTray()
  }
}

/** 在 Electron IPC 入口确认安装表单能生成一个可用的 Harness 设置。 */
function cloneProgressReporter(report, message) {
  return line => {
    const match = /(?:Receiving objects|Resolving deltas):\s+(\d+)%/u.exec(line)
    if (match !== null) report(14 + Math.round(Number(match[1]) * 0.24), message)
  }
}

class RetryableInstallError extends Error {}

async function cloneWithRetry(targetRuntime, form, networkEnvironment, report, installText) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await targetRuntime.run('git', ['init', form.installPath])
      await targetRuntime.run('git', ['remote', 'add', 'origin', repository], form.installPath)
      await targetRuntime.run('git', ['fetch', '--depth', '1', '--progress', 'origin', installSourceRef], form.installPath, cloneProgressReporter(report, installText.downloading), { env: networkEnvironment })
      await targetRuntime.run('git', ['reset', '--hard', 'FETCH_HEAD'], form.installPath)
      return
    } catch (error) {
      await targetRuntime.resetInstallDirectory(form.installPath)
      if (attempt === 3) throw new RetryableInstallError((error instanceof Error ? error.message : String(error)) + installText.retryHint)
      report(14, installText.retrying + ' (' + String(attempt + 1) + '/3)')
    }
  }
}

async function updateExistingWithRetry(targetRuntime, form, networkEnvironment, report, installText) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await targetRuntime.run('git', ['remote', 'set-url', 'origin', repository], form.installPath)
      await targetRuntime.run('git', ['fetch', '--depth', '1', 'origin', installSourceRef], form.installPath, () => report(22, installText.overwriting), { env: networkEnvironment })
      await targetRuntime.run('git', ['reset', '--hard', 'FETCH_HEAD'], form.installPath, () => report(36, installText.overwriting))
      return
    } catch (error) {
      if (attempt < 3) {
        report(14, installText.retrying + ' (' + String(attempt + 1) + '/3)')
        continue
      }
      throw new RetryableInstallError((error instanceof Error ? error.message : String(error)) + installText.retryHint)
    }
  }
}

async function installDependenciesWithRetry(targetRuntime, form, networkEnvironment, report, installText, preserveTarget) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await targetRuntime.runPnpm(['install', '--frozen-lockfile'], form.installPath, () => report(58, installText.installing), { env: networkEnvironment })
      return
    } catch (error) {
      if (attempt < 3) {
        report(48, installText.retryingDependencies + ' (' + String(attempt + 1) + '/3)')
        continue
      }
      if (!preserveTarget) await targetRuntime.resetInstallDirectory(form.installPath)
      throw new RetryableInstallError((error instanceof Error ? error.message : String(error)) + installText.retryHint)
    }
  }
}

async function assertLocalPortsAvailable(form, ports) {
  for (const port of ports) {
    await new Promise((resolve, reject) => {
      const probe = createServer()
      const fail = () => {
        probe.close(() => reject(new Error(form.locale === 'zh' ? `端口 ${String(port)} 已被占用，请选择其他端口。` : `Port ${String(port)} is already in use. Choose another port.`)))
      }
      probe.once('error', fail)
      probe.listen(port, '127.0.0.1', () => probe.close(resolve))
    })
  }
}

function validateInstall(form) {
  if (!form.installPath || !form.apiKey || !form.model) throw new Error('Choose an installation folder, API key, and model.')
  if (!catalogProviders.has(form.provider) && form.provider !== 'custom') throw new Error('Choose a supported model provider.')
  if (form.proxy) {
    let proxyUrl
    try { proxyUrl = new URL(form.proxy) } catch { throw new Error('Enter a valid HTTP, HTTPS, or SOCKS5 proxy URL.') }
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxyUrl.protocol)) throw new Error('Enter a valid HTTP, HTTPS, or SOCKS5 proxy URL.')
  }
  if (form.provider === 'custom' && (!form.customName || !form.baseURL)) throw new Error('Enter a name and URL for the custom provider.')
  if (form.provider === 'custom' && (!URL.canParse(form.baseURL) || !['http:', 'https:'].includes(new URL(form.baseURL).protocol))) throw new Error('Enter a valid HTTP or HTTPS URL for the custom provider.')
  if (form.target?.kind !== 'native' && form.target?.kind !== 'wsl') throw new Error('Choose Windows or WSL as the installation location.')
  if (form.target.kind === 'wsl' && (!form.target.distribution || process.platform !== 'win32')) throw new Error('Choose an installed WSL distribution.')
  if (form.locale !== 'zh' && form.locale !== 'en') throw new Error('Choose a supported interface language.')
  if (!['system', 'light', 'dark'].includes(form.theme)) throw new Error('Choose a supported interface theme.')
  const ports = [form.port, form.candidatePort, form.supervisorPort, form.candidateSupervisorPort].map(Number)
  if (ports.some(value => !Number.isSafeInteger(value) || value < 1024 || value > 65535)) throw new Error('Choose local ports between 1024 and 65535.')
  if (new Set(ports).size !== ports.length) throw new Error('Each local port must be different.')
  return ports[0]
}

/** 安装全过程都在用户选择的 Windows 或 WSL 目标内执行。 */
async function install(form) {
  if (runtime !== undefined) throw new Error('DeepSeek Harness Plus is already installed.')
  const port = validateInstall(form)
  const targetRuntime = new TargetRuntime(form.target)
  await assertLocalPortsAvailable(form, [port, Number(form.candidatePort), Number(form.supervisorPort), Number(form.candidateSupervisorPort)])
  const networkEnvironment = proxyEnvironment(form.proxy)
  const configured = runtimeFor(form, port)
  busy = 'Installing DeepSeek Harness Plus...'
  refreshTray()
  try {
    const report = (percent, message) => {
      busy = message
      sendInstaller('install:progress', { percent, message })
      refreshTray()
    }
    const installText = form.locale === 'zh'
      ? {
          preparing: '正在准备安装…', checking: '正在检查安装环境…', downloading: '正在下载 Harness…',
          configuring: '正在写入设置…', overwriting: '正在更新已有 Harness…', installing: '正在安装依赖…', building: '正在构建 Harness…',
          starting: '正在启动 Harness…', retrying: '下载失败，正在重试…', retryingDependencies: '依赖下载失败，正在重试…', retryHint: ' 请检查下载代理后重试。', complete: '安装完成。',
        }
      : {
          preparing: 'Preparing installation…', checking: 'Checking the installation environment…', downloading: 'Downloading Harness…',
          configuring: 'Writing settings…', overwriting: 'Updating existing Harness…', installing: 'Installing dependencies…', building: 'Building Harness…',
          starting: 'Starting Harness…', retrying: 'Download failed, retrying…', retryingDependencies: 'Dependency download failed, retrying…', retryHint: ' Check the download proxy and retry.', complete: 'Installation complete.',
        }
    report(2, installText.preparing)
    report(7, installText.checking)
    await targetRuntime.run('git', ['--version'], undefined, undefined, { env: networkEnvironment })
    report(10, installText.checking)
    await targetRuntime.runPnpm(['--version'], undefined, undefined, { env: networkEnvironment })
    const targetState = await targetRuntime.installationDirectoryState(form.installPath)
    const overwriteExisting = targetState === 'harness' && form.overwrite
    if (targetState === 'empty') {
      report(14, installText.downloading)
      await targetRuntime.assertEmptyDirectory(form.installPath)
      await cloneWithRetry(targetRuntime, form, networkEnvironment, report, installText)
    } else if (targetState === 'harness' && form.overwrite) {
      await updateExistingWithRetry(targetRuntime, form, networkEnvironment, report, installText)
    } else if (targetState === 'harness') {
      throw new Error(form.locale === 'zh' ? '该目录已有 Harness，请勾选覆盖已有安装。' : 'This folder already contains Harness. Enable overwrite to continue.')
    } else if (targetState === 'linked') {
      throw new Error(form.locale === 'zh' ? '不能覆盖链接目录，请选择真实文件夹。' : 'Cannot overwrite a linked folder. Choose a real folder.')
    } else {
      throw new Error(form.locale === 'zh' ? '请选择空目录或已有 Harness 安装目录。' : 'Choose an empty folder or an existing Harness installation folder.')
    }
    report(40, installText.configuring)
    await targetRuntime.makeDirectory(targetRuntime.join(form.installPath, '.dsh-plus', 'logs'))
    const settingsPath = targetRuntime.join(configured.dshHome, 'settings.yaml')
    const credentialsPath = targetRuntime.join(configured.dshHome, '.credentials.yaml')
    if (!await targetRuntime.fileExists(settingsPath)) await targetRuntime.writeText(settingsPath, settingsDocument(form))
    if (!await targetRuntime.fileExists(credentialsPath)) await targetRuntime.writeText(credentialsPath, credentialsDocument(form))
    report(48, installText.installing)
    await installDependenciesWithRetry(targetRuntime, form, networkEnvironment, report, installText, overwriteExisting)
    report(76, installText.building)
    await targetRuntime.runPnpm(['run', 'build'], form.installPath, () => report(86, installText.building), { env: networkEnvironment })
    daemon.configure(configured)
    report(94, installText.starting)
    await daemon.start()
    await saveRuntime(configured)
    report(100, installText.complete)
    void shell.openExternal('http://127.0.0.1:' + String(configured.port)).catch(error => {
      console.error('[plus-desktop] opening installed Harness failed', error)
      dialog.showErrorBox('DeepSeek Harness Plus', error instanceof Error ? error.message : String(error))
    })
    installerWindow?.close()
    return { installed: true }
  } finally {
    busy = undefined
    refreshTray()
  }
}

async function assertInstalled() {
  if (runtime === undefined) throw new Error('Install DeepSeek Harness Plus before using this action.')
  await new TargetRuntime(runtime.target).assertDirectory(runtime.installPath)
}

async function applyUpgrade(sourceRef) {
  await assertInstalled()
  const targetRuntime = new TargetRuntime(runtime.target)
  const networkEnvironment = proxyEnvironment(runtime.proxy)
  const restart = (await daemon.snapshot()).state === 'running'
  const report = message => { busy = message; updatesWindow?.webContents.send('updates:progress', { message }); refreshTray() }
  await targetRuntime.run('git', ['remote', 'set-url', 'origin', repository], runtime.installPath)
  await targetRuntime.run('git', ['fetch', '--depth', '1', 'origin', sourceRef], runtime.installPath, report, { env: networkEnvironment })
  await targetRuntime.run('git', ['reset', '--hard', 'FETCH_HEAD'], runtime.installPath, report)
  await targetRuntime.runPnpm(['install', '--frozen-lockfile'], runtime.installPath, report, { env: networkEnvironment })
  await targetRuntime.runPnpm(['run', 'build'], runtime.installPath, report, { env: networkEnvironment })
  if (restart) await daemon.restart(false)
  await saveRuntime({ ...runtime, sourceRef })
}

async function upgrade(sourceRef = releaseSourceRef) {
  await action(trayText('upgrade'), () => applyUpgrade(sourceRef))
}

async function repair() {
  await action(trayText('repair'), async () => {
    await assertInstalled()
    const targetRuntime = new TargetRuntime(runtime.target)
    const networkEnvironment = proxyEnvironment(runtime.proxy)
    const restart = (await daemon.snapshot()).state === 'running'
    const report = message => { busy = message; refreshTray() }
    await targetRuntime.runPnpm(['install', '--frozen-lockfile'], runtime.installPath, report, { env: networkEnvironment })
    await targetRuntime.runPnpm(['run', 'build'], runtime.installPath, report, { env: networkEnvironment })
    if (restart) await daemon.restart(false)
  })
}

async function releaseVersions() {
  await assertInstalled()
  const targetRuntime = new TargetRuntime(runtime.target)
  const networkEnvironment = proxyEnvironment(runtime.proxy)
  const [remoteTags, currentRef] = await Promise.all([
    targetRuntime.run('git', ['ls-remote', '--tags', repository], undefined, undefined, { env: networkEnvironment }),
    targetRuntime.run('git', ['rev-parse', 'HEAD'], runtime.installPath).then(value => value.trim()),
  ])
  const refs = new Map()
  for (const line of remoteTags.split(/\r?\n/u).filter(Boolean)) {
    const [sourceRef, rawRef] = line.split(/\s+/u)
    const match = /^refs\/tags\/(plus-v[^\^]+)(\^\{\})?$/u.exec(rawRef ?? '')
    if (sourceRef && match) {
      const peeled = match[2] !== undefined
      if (peeled || !refs.has(match[1])) refs.set(match[1], { sourceRef, peeled })
    }
  }
  const versions = [...refs.entries()].map(([tag, value]) => ({ tag, sourceRef: value.sourceRef }))
  versions.sort((left, right) => right.tag.localeCompare(left.tag, undefined, { numeric: true }))
  return { locale: locale(), currentRef, versions: versions.map(version => ({ ...version, current: version.sourceRef === currentRef })) }
}

async function harnessRpc(method, payload) {
  const response = await fetch('http://127.0.0.1:' + String(runtime.port) + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'plus-update-' + method + '-' + Date.now(), method, payload }),
  })
  if (!response.ok) throw new Error(method + ' failed over HTTP ' + String(response.status) + ': ' + await response.text())
  const body = await response.json()
  if (!body.result?.ok) throw new Error(method + ' failed: ' + String(body.result?.error?.message ?? 'unknown error'))
  return body.result.value
}

async function openHarnessSession(sessionId) {
  const url = 'http://127.0.0.1:' + String(runtime.port)
  harnessWindow?.close()
  harnessWindow = new BrowserWindow({ width: 1180, height: 820, title: 'DeepSeek Harness Plus', webPreferences: { contextIsolation: true, sandbox: true } })
  harnessWindow.once('closed', () => { harnessWindow = undefined })
  harnessWindow.webContents.once('did-finish-load', async () => {
    const value = JSON.stringify(JSON.stringify({ sessionId }))
    await harnessWindow?.webContents.executeJavaScript("localStorage.setItem('dsh.sessions.current', " + value + ')')
    await harnessWindow?.loadURL(url)
  })
  await harnessWindow.loadURL(url)
}

async function aiMergeVersion(sourceRef, tag) {
  await assertInstalled()
  if ((await daemon.snapshot()).state !== 'running') await daemon.start()
  const created = await harnessRpc('session.create', { cwd: runtime.installPath })
  const instruction = [
    '将当前 DeepSeek Harness Plus 工作区升级或回退到 release ' + tag + '，目标 commit 为 ' + sourceRef + '。',
    '先检查 git status、当前 HEAD 和所有本地 diff。保留用户对源码的修改以及 .dsh-plus/home 下的设置、凭据和会话数据。',
    '从 ' + repository + ' 获取目标 commit，使用合并或逐项迁移的方式整合目标版本与本地修改；不要直接 reset --hard 或删除用户数据。',
    '解决冲突后安装依赖、运行相关检查并报告改动、测试结果和仍需人工确认的冲突。',
  ].join('\n')
  await harnessRpc('session.prompt', { sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: instruction }] })
  await openHarnessSession(created.sessionId)
  return { sessionId: created.sessionId }
}

function openUpdatesWindow() {
  if (runtime === undefined) return
  if (updatesWindow !== undefined) { updatesWindow.show(); updatesWindow.focus(); return }
  updatesWindow = new BrowserWindow({
    width: 760, height: 560, minWidth: 660, minHeight: 480, title: trayText('updateTitle'), backgroundColor: nativeTheme.shouldUseDarkColors ? '#232324' : '#ffffff',
    webPreferences: { preload: join(currentDirectory, 'preload.mjs'), contextIsolation: true, sandbox: false },
  })
  updatesWindow.loadFile(join(currentDirectory, '..', 'renderer', 'updates.html'))
  updatesWindow.once('closed', () => { updatesWindow = undefined })
}

async function checkUpdates() {
  await assertInstalled()
  openUpdatesWindow()
}

/**
 * 打开备份与恢复窗口；导出把 dshHome 打包为 zip，导入从 zip 恢复用户数据。
 * WSL 目标的 dshHome 经 UNC 路径访问，压缩包可在 WSL 与 Windows 安装之间迁移。
 */
function openBackupWindow() {
  if (runtime === undefined) return
  if (backupWindow !== undefined) { backupWindow.show(); backupWindow.focus(); return }
  backupWindow = new BrowserWindow({
    width: 640, height: 500, minWidth: 560, minHeight: 430, title: trayText('backupTitle'), backgroundColor: nativeTheme.shouldUseDarkColors ? '#232324' : '#ffffff',
    webPreferences: { preload: join(currentDirectory, 'preload.mjs'), contextIsolation: true, sandbox: false },
  })
  backupWindow.loadFile(join(currentDirectory, '..', 'renderer', 'backup.html'))
  backupWindow.once('closed', () => { backupWindow = undefined })
}

/** 返回主进程可直接读写的 dshHome 路径：native 路径原样使用，WSL 转换为 UNC 路径。 */
function backupDataPath() {
  return new TargetRuntime(runtime.target).uncPath(runtime.dshHome)
}

async function handleBackupState() {
  await assertInstalled()
  return { locale: locale(), running: supervisorSnapshot?.state === 'running', dshHome: runtime.dshHome, targetKind: runtime.target.kind }
}

/** options.targetPath 由测试直接指定时跳过保存对话框。 */
async function handleBackupExport(options = {}) {
  await assertInstalled()
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/gu, '').replace('T', '-')
  let targetPath = options.targetPath
  if (targetPath === undefined) {
    const choice = await dialog.showSaveDialog({
      title: trayText('backupTitle'),
      defaultPath: join(app.getPath('documents'), 'deepseek-harness-plus-backup-' + stamp + '.zip'),
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    })
    if (choice.canceled || choice.filePath === null) return { canceled: true }
    targetPath = choice.filePath
  }
  const result = exportUserBackup(backupDataPath(), targetPath)
  return { canceled: false, ...result }
}

/** options.archivePath + options.confirmed 由测试直接指定时跳过选择和确认对话框。 */
async function handleBackupImport(options = {}) {
  await assertInstalled()
  let archivePath = options.archivePath
  if (archivePath === undefined) {
    const choice = await dialog.showOpenDialog({
      title: trayText('backupTitle'),
      properties: ['openFile'],
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    })
    if (choice.canceled || choice.filePaths.length === 0) return { canceled: true }
    archivePath = choice.filePaths[0]
  }
  if (options.confirmed !== true) {
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      message: trayText('backupImportMessage'),
      detail: trayText('backupImportDetail'),
      buttons: [trayText('backupImportConfirm'), trayText('backupCancel')],
      defaultId: 1,
      cancelId: 1,
    })
    if (confirmation.response !== 0) return { canceled: true }
  }
  // 先校验压缩包再停止 runtime：无效压缩包不应把 Harness 停在停止状态。
  let validated
  try {
    validated = validateUserBackup(archivePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('missing ' + BACKUP_MANIFEST_ENTRY)) throw new Error(trayText('backupNotArchive'))
    if (message.includes('unsafe path')) throw new Error(trayText('backupUnsafeArchive'))
    throw error
  }
  // 实时查询 Supervisor 状态；模块级缓存快照可能滞后，会把运行中的 Harness 误判为停止。
  const wasRunning = (await daemon.snapshot()).state === 'running'
  if (wasRunning) await daemon.stop()
  const result = restoreUserBackup(validated, backupDataPath())
  if (wasRunning) await daemon.start()
  return { canceled: false, restarted: wasRunning, ...result }
}

async function openProduction() {
  await assertInstalled()
  await shell.openExternal('http://127.0.0.1:' + String(runtime.port))
}

async function openCandidate() {
  await shell.openExternal('http://127.0.0.1:' + String(runtime.candidatePort))
}

async function openSupervisor() {
  await daemon.snapshot()
  await shell.openExternal('http://127.0.0.1:' + String(runtime.supervisorPort))
}

async function openDataFolder() {
  await assertInstalled()
  const targetRuntime = new TargetRuntime(runtime.target)
  await targetRuntime.openPath(shell, targetRuntime.join(runtime.installPath, '.dsh-plus'))
}

/** 使用 Electron utility process 启动 native Supervisor，确保打包 Windows helper 正确加载 unpacked ESM 入口。 */
function launchNativeSupervisor(scriptPath, args, config, environment) {
  const recordFailure = detail => {
    console.error('[plus-desktop] native Supervisor utility process failed', detail)
    void appendFile(config.supervisorStartupErrorPath, String(detail) + String.fromCharCode(10), { mode: 0o600 }).catch(error => console.error('[plus-desktop] native Supervisor diagnostic write failed', error))
  }
  const child = utilityProcess.fork(scriptPath, args, {
    cwd: config.installPath,
    env: { ...process.env, ...environment },
    stdio: 'pipe',
    serviceName: 'DeepSeek Harness Plus Supervisor',
  })
  child.stdout?.on('data', chunk => console.info('[plus-desktop] native Supervisor stdout', chunk.toString('utf8').trim()))
  child.stderr?.on('data', chunk => recordFailure(chunk.toString('utf8').trim()))
  child.once('error', (type, location, report) => recordFailure(JSON.stringify({ type, location, report })))
  child.once('exit', (code, signal) => {
    if (code !== 0) recordFailure(JSON.stringify({ code, signal }))
  })
  return child
}

const daemon = new HarnessDaemon(() => {
  refreshTray()
}, supervisorBootstrapPath, launchNativeSupervisor)

/** 将历史本机配置提升为当前的显式 target、实例和 Supervisor 端口配置。 */
async function migrateRuntime(saved) {
  if (saved.version === 4) return saved
  const settings = parseYaml(await readFile(join(saved.dshHome, 'settings.yaml'), 'utf8'))
  const current = { ...saved }
  delete current.progressPort
  delete current.candidateProgressPort
  const target = saved.target ?? { kind: 'native' }
  const targetRuntime = new TargetRuntime(target)
  const supervisorDirectory = targetRuntime.join(saved.dshHome, 'supervisor')
  const supervisorPort = Number(saved.supervisorPort ?? saved.progressPort ?? defaultSupervisorPort)
  const candidatePort = Number(saved.candidatePort ?? defaultCandidatePort)
  const candidateSupervisorPort = Number(saved.candidateSupervisorPort ?? saved.candidateProgressPort ?? defaultCandidateSupervisorPort)
  return {
    ...current,
    version: 4,
    target,
    candidatePort,
    supervisorPort,
    candidateSupervisorPort,
    supervisorSocketPath: target.kind === 'wsl' ? saved.supervisorSocketPath : nativeSupervisorSocketPath(supervisorPort),
    supervisorManifestPath: saved.supervisorManifestPath ?? nativeSupervisorManifestPath(),
    supervisorStartupErrorPath: targetRuntime.isWsl ? targetRuntime.join(supervisorDirectory, 'runtime-supervisor-startup.error.log') : nativeSupervisorStartupErrorPath(),
    locale: settings?.locale?.preference === 'en' ? 'en' : 'zh',
    theme: ['light', 'dark', 'system'].includes(settings?.['ui-theme']?.preference) ? settings['ui-theme'].preference : 'system',
  }
}

async function loadRuntime() {
  try {
    const configured = await migrateRuntime(JSON.parse(await readFile(setupPath(), 'utf8')))
    await saveRuntime(configured)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      runtime = undefined
      return
    }
    throw error
  }
}

function directoryBrowserRoot(target) {
  if (target?.kind === 'native') return homedir()
  if (target?.kind !== 'wsl' || !target.distribution || process.platform !== 'win32') throw new Error('Choose a supported installation target.')
  return ['', '', 'wsl.localhost', target.distribution, 'home'].join('\\')
}

function fullyQualifiedDirectoryPath(path) {
  return process.platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/u.test(path)
    : isAbsolute(path)
}

function directoryBrowserPath(target, requested) {
  const root = directoryBrowserRoot(target)
  const candidate = requested ?? root
  if (!fullyQualifiedDirectoryPath(candidate)) throw new Error('Choose an absolute directory.')
  const path = resolve(candidate)
  if (target.kind === 'wsl' && !path.toLowerCase().startsWith(root.toLowerCase() + '\\') && path.toLowerCase() !== root.toLowerCase()) throw new Error('Choose a folder inside the selected Linux distribution.')
  return path
}

function directoryCrumbs(path) {
  const crumbs = []
  let current = path
  for (;;) {
    const parent = dirname(current)
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (parent === current) return crumbs
    current = parent
  }
}

async function listDirectoryEntries(target, requested) {
  const home = directoryBrowserRoot(target)
  const path = directoryBrowserPath(target, requested)
  const candidates = []
  let truncated = false
  const level = await opendir(path)
  try {
    for (;;) {
      const entry = await level.read()
      if (entry === null) break
      if (!entry.isDirectory()) continue
      if (candidates.length >= 1000) { truncated = true; continue }
      candidates.push({ name: entry.name, path: join(path, entry.name), hidden: entry.name.startsWith('.') })
    }
  } finally {
    await level.close()
  }
  candidates.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
  return { path, home, crumbs: directoryCrumbs(path), parent: path.toLowerCase() === home.toLowerCase() ? null : dirname(path), entries: candidates, truncated }
}

async function createDirectoryEntry(target, parent, name) {
  const path = directoryBrowserPath(target, parent)
  const folder = name.trim()
  if (!folder || folder === '.' || folder === '..' || /[\\/]/u.test(folder)) throw new Error('Enter one folder name without path separators.')
  const created = join(path, folder)
  await mkdir(created)
  return created
}

ipcMain.handle('installer:list-directories', (_event, target, path) => listDirectoryEntries(target, path))
ipcMain.handle('installer:create-directory', (_event, target, path, name) => createDirectoryEntry(target, path, name))
ipcMain.handle('installer:select-directory', (_event, target, path) => new TargetRuntime(target).pathFromDirectoryPicker(directoryBrowserPath(target, path)))
ipcMain.handle('installer:list-wsl-distributions', () => listWslDistributions())
ipcMain.handle('installer:apply-appearance', (_event, appearance) => {
  installerLocale = appearance.locale
  nativeTheme.themeSource = appearance.theme
  const dark = appearance.resolvedTheme === 'dark'
  installerWindow?.setBackgroundColor(dark ? '#232324' : '#ffffff')
  if (process.platform === 'win32') installerWindow?.setTitleBarOverlay({ color: dark ? '#232324' : '#ffffff', symbolColor: dark ? '#adb2b8' : '#61666b' })
  installerWindow?.setTitle(appearance.title)
})
async function handleInstallerInstall(form) {
  try {
    const result = await install(form)
    if (process.env.DSH_PLUS_DESKTOP_TEST_SEAM === '1' && result.installed) openBackupWindow()
    return result
  } catch (error) {
    return {
      installed: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: error instanceof RetryableInstallError,
    }
  }
}

ipcMain.handle('installer:install', (_event, form) => handleInstallerInstall(form))
ipcMain.handle('updates:list', () => releaseVersions())
ipcMain.handle('backup:state', () => handleBackupState())
ipcMain.handle('backup:export', (_event, options) => handleBackupExport(options ?? {}))
ipcMain.handle('backup:import', (_event, options) => handleBackupImport(options ?? {}))
ipcMain.handle('updates:upgrade', async (_event, sourceRef) => {
  const available = await releaseVersions()
  const version = available.versions.find(entry => entry.sourceRef === sourceRef)
  if (version === undefined) throw new Error('Choose an available Plus release.')
  await applyUpgrade(version.sourceRef)
  return await releaseVersions()
})
ipcMain.handle('updates:ai-merge', async (_event, sourceRef) => {
  const available = await releaseVersions()
  const version = available.versions.find(entry => entry.sourceRef === sourceRef)
  if (version === undefined) throw new Error('Choose an available Plus release.')
  return await aiMergeVersion(version.sourceRef, version.tag)
})

/**
 * 测试驱动缝：原生对话框和托盘菜单无法被 Playwright 操作。
 * 仅在测试环境以文件驱动的固定选择替换对话框应答，并在安装完成后自动打开备份窗口；
 * 业务步骤仍全部经由备份窗口 UI 完成。
 */
if (process.env.DSH_PLUS_DESKTOP_TEST_SEAM === '1') {
  const dialogSelectionsPath = process.env.DSH_PLUS_DESKTOP_TEST_DIALOGS
  const readDialogSelections = () => JSON.parse(readFileSync(dialogSelectionsPath, 'utf8'))
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: readDialogSelections().savePath })
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [readDialogSelections().openPath] })
  dialog.showMessageBox = async () => ({ response: readDialogSelections().confirm ?? 0 })
}

app.whenReady().then(async () => {
  try {
    await loadRuntime()
  } catch (error) {
    console.error('[plus-desktop] saved runtime load failed', error)
    dialog.showErrorBox('DeepSeek Harness Plus', 'The saved tray runtime configuration is invalid: ' + (error instanceof Error ? error.message : String(error)))
    runtime = undefined
  }
  tray = new Tray(icon())
  const initialSetup = runtime === undefined || consumeSetupMarker()
  const showTrayMenu = async () => {
    if (initialSetup) { openInstaller(); return }
    try { await syncSupervisorStatus() }
    catch (error) { console.error('[plus-desktop] tray status refresh failed', error); supervisorSnapshot = undefined; refreshTray() }
    tray.popUpContextMenu(trayMenu)
  }
  tray.on('click', () => { void showTrayMenu() })
  tray.on('right-click', () => { void showTrayMenu() })
  refreshTray()
  if (initialSetup) openInstaller()
  else void syncSupervisorStatus().catch(error => {
    console.error('[plus-desktop] initial Supervisor status failed', error)
    supervisorSnapshot = undefined
    refreshTray()
  })
})
