import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import { parse as parseYaml } from 'yaml'
import { HarnessDaemon } from './daemon.mjs'
import { listWslDistributions, TargetRuntime } from './target-runtime.mjs'

const repository = 'https://github.com/SparkElf/deepseek-harness-plus.git'
const currentDirectory = dirname(fileURLToPath(import.meta.url))
const setupPath = () => join(app.getPath('userData'), 'runtime.json')
const nativeSupervisorSocketPath = () => process.platform === 'win32' ? 'deepseek-harness-plus-runtime' : join(app.getPath('userData'), 'runtime-supervisor.sock')
const nativeSupervisorManifestPath = () => join(app.getPath('userData'), 'runtime-supervisor.json')
const candidatePort = 3081
const progressPort = 3082
const candidateProgressPort = 3083
let tray
let installerWindow
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
    start: '启动 Harness', stop: '停止 Harness', rebuild: '构建并重启', install: '安装 Plus…', checkUpdates: '检查更新',
    upgrade: '升级 Plus', repair: '修复安装', openData: '打开本地数据目录', quit: '退出',
    checkingUpdates: '正在检查更新…', updateAvailable: '发现 {{count}} 个新提交。', upToDate: '当前已经是最新版本。',
    updateTitle: 'DeepSeek Harness Plus 更新', targetWindows: 'Windows', targetLinux: 'Linux', targetMacos: 'macOS', targetWsl: 'WSL · {{distribution}}',
  },
  en: {
    supervisorOffline: 'Supervisor offline', supervisorOnline: 'Supervisor online', harnessRunning: 'Harness running', harnessStopped: 'Harness stopped', candidateRunning: 'Candidate Harness available', candidateStopped: 'Candidate Harness not running',
    openProduction: 'Open production Harness', openCandidate: 'Open candidate Harness', openSupervisor: 'Open Supervisor',
    start: 'Start Harness', stop: 'Stop Harness', rebuild: 'Build and restart', install: 'Install Plus…', checkUpdates: 'Check for updates',
    upgrade: 'Upgrade Plus', repair: 'Repair installation', openData: 'Open local data folder', quit: 'Quit',
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

function runtimeFor(form, port) {
  const targetRuntime = new TargetRuntime(form.target)
  const dshHome = targetRuntime.join(form.installPath, '.dsh-plus', 'home')
  const supervisorDirectory = targetRuntime.join(dshHome, 'supervisor')
  return {
    version: 2,
    target: form.target,
    installPath: form.installPath,
    dshHome,
    port,
    candidatePort,
    progressPort,
    supervisorSocketPath: targetRuntime.isWsl ? targetRuntime.join(supervisorDirectory, 'runtime-supervisor.sock') : nativeSupervisorSocketPath(),
    supervisorManifestPath: targetRuntime.isWsl ? targetRuntime.join(supervisorDirectory, 'runtime-supervisor.json') : nativeSupervisorManifestPath(),
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
  if (runtime !== undefined) return
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
    { label: trayText('install'), enabled: !installed && !maintenanceBusy, click: openInstaller },
    { label: trayText('checkUpdates'), enabled: installed && !maintenanceBusy, click: () => checkUpdates() },
    { label: trayText('upgrade'), enabled: installed && !maintenanceBusy, click: () => upgrade() },
    { label: trayText('repair'), enabled: installed && !maintenanceBusy, click: () => repair() },
    { label: trayText('openData'), enabled: installed && !maintenanceBusy, click: openDataFolder },
    { type: 'separator' },
    { label: trayText('quit'), click: async () => { await daemon.stop(); app.quit() } },
  ])
  tray.setContextMenu(trayMenu)
}

function candidateRuntimeIsAvailable() {
  return new Promise(resolve => {
    const probe = request({ host: '127.0.0.1', port: candidateProgressPort, path: '/api/status', method: 'GET', timeout: 500 }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.once('end', () => {
        try {
          const snapshot = JSON.parse(body)
          resolve(response.statusCode === 200 && snapshot.runtime?.port === candidatePort && snapshot.runtime?.state === 'running')
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
function validateInstall(form) {
  if (!form.installPath || !form.apiKey || !form.model) throw new Error('Choose an installation folder, API key, and model.')
  if (!catalogProviders.has(form.provider) && form.provider !== 'custom') throw new Error('Choose a supported model provider.')
  if (form.provider === 'custom' && (!form.customName || !form.baseURL)) throw new Error('Enter a name and URL for the custom provider.')
  if (form.provider === 'custom' && (!URL.canParse(form.baseURL) || !['http:', 'https:'].includes(new URL(form.baseURL).protocol))) throw new Error('Enter a valid HTTP or HTTPS URL for the custom provider.')
  if (form.target?.kind !== 'native' && form.target?.kind !== 'wsl') throw new Error('Choose Windows or WSL as the installation location.')
  if (form.target.kind === 'wsl' && (!form.target.distribution || process.platform !== 'win32')) throw new Error('Choose an installed WSL distribution.')
  if (form.locale !== 'zh' && form.locale !== 'en') throw new Error('Choose a supported interface language.')
  if (!['system', 'light', 'dark'].includes(form.theme)) throw new Error('Choose a supported interface theme.')
  const port = Number(form.port)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a local port between 1024 and 65535.')
  if (port === candidatePort || port === progressPort || port === candidateProgressPort) throw new Error('Choose another local port.')
  return port
}

/** 安装全过程都在用户选择的 Windows 或 WSL 目标内执行。 */
async function install(form) {
  if (runtime !== undefined) throw new Error('DeepSeek Harness Plus is already installed.')
  const port = validateInstall(form)
  const targetRuntime = new TargetRuntime(form.target)
  const configured = runtimeFor(form, port)
  busy = 'Installing DeepSeek Harness Plus...'
  refreshTray()
  try {
    const report = message => {
      busy = message
      sendInstaller('install:progress', { message })
      refreshTray()
    }
    const installText = form.locale === 'zh'
      ? { preparing: '正在准备安装…', downloading: '正在下载 Harness…', installing: '正在安装…', starting: '正在启动 Harness…' }
      : { preparing: 'Preparing installation…', downloading: 'Downloading Harness…', installing: 'Installing Harness…', starting: 'Starting Harness…' }
    report(installText.preparing)
    await targetRuntime.run('git', ['--version'])
    await targetRuntime.run('pnpm', ['--version'])
    await targetRuntime.assertEmptyDirectory(form.installPath)
    report(installText.downloading)
    await targetRuntime.run('git', ['clone', '--depth', '1', repository, form.installPath])
    await targetRuntime.makeDirectory(targetRuntime.join(form.installPath, '.dsh-plus', 'logs'))
    await targetRuntime.writeText(targetRuntime.join(configured.dshHome, 'settings.yaml'), settingsDocument(form))
    await targetRuntime.writeText(targetRuntime.join(configured.dshHome, '.credentials.yaml'), credentialsDocument(form))
    report(installText.installing)
    await targetRuntime.run('pnpm', ['install', '--frozen-lockfile'], form.installPath)
    await targetRuntime.run('pnpm', ['run', 'build'], form.installPath)
    daemon.configure(configured)
    report(installText.starting)
    await daemon.start()
    await saveRuntime(configured)
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

async function upgrade() {
  await action(trayText('upgrade'), async () => {
    await assertInstalled()
    const targetRuntime = new TargetRuntime(runtime.target)
    const restart = (await daemon.snapshot()).state === 'running'
    const report = message => { busy = message; refreshTray() }
    await targetRuntime.run('git', ['pull', '--ff-only'], runtime.installPath, report)
    await targetRuntime.run('pnpm', ['install', '--frozen-lockfile'], runtime.installPath, report)
    await targetRuntime.run('pnpm', ['run', 'build'], runtime.installPath, report)
    if (restart) await daemon.restart(false)
  })
}

async function repair() {
  await action(trayText('repair'), async () => {
    await assertInstalled()
    const targetRuntime = new TargetRuntime(runtime.target)
    const restart = (await daemon.snapshot()).state === 'running'
    const report = message => { busy = message; refreshTray() }
    await targetRuntime.run('pnpm', ['install', '--frozen-lockfile'], runtime.installPath, report)
    await targetRuntime.run('pnpm', ['run', 'build'], runtime.installPath, report)
    if (restart) await daemon.restart(false)
  })
}

async function checkUpdates() {
  await action(trayText('checkingUpdates'), async () => {
    await assertInstalled()
    const targetRuntime = new TargetRuntime(runtime.target)
    await targetRuntime.run('git', ['fetch'], runtime.installPath)
    const count = Number((await targetRuntime.run('git', ['rev-list', '--count', 'HEAD..@{upstream}'], runtime.installPath)).trim())
    await dialog.showMessageBox({ type: 'info', title: trayText('updateTitle'), message: count > 0 ? trayText('updateAvailable', { count }) : trayText('upToDate') })
  })
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
  await shell.openExternal('http://127.0.0.1:' + String(runtime.progressPort))
}

async function openDataFolder() {
  await assertInstalled()
  const targetRuntime = new TargetRuntime(runtime.target)
  await targetRuntime.openPath(shell, targetRuntime.join(runtime.installPath, '.dsh-plus'))
}

const daemon = new HarnessDaemon(() => {
  refreshTray()
}, join(currentDirectory, 'supervisor.mjs'))

/** 将 0.2.0 本机配置提升为带显式 target、主题和语言的当前配置。 */
async function migrateRuntime(saved) {
  if (saved.version === 2) return saved
  const settings = parseYaml(await readFile(join(saved.dshHome, 'settings.yaml'), 'utf8'))
  return {
    ...saved,
    version: 2,
    target: { kind: 'native' },
    supervisorSocketPath: nativeSupervisorSocketPath(),
    supervisorManifestPath: nativeSupervisorManifestPath(),
    candidatePort,
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

function directoryBrowserPath(target, requested) {
  const root = directoryBrowserRoot(target)
  const candidate = requested ?? root
  if (!isAbsolute(candidate)) throw new Error('Choose an absolute directory.')
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
  const entries = (await readdir(path, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, path: join(path, entry.name), hidden: entry.name.startsWith('.') }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
  return { path, home, crumbs: directoryCrumbs(path), parent: path.toLowerCase() === home.toLowerCase() ? null : dirname(path), entries }
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
ipcMain.handle('installer:install', (_event, form) => install(form))

app.whenReady().then(async () => {
  try {
    await loadRuntime()
  } catch (error) {
    console.error('[plus-desktop] saved runtime load failed', error)
    dialog.showErrorBox('DeepSeek Harness Plus', 'The saved tray runtime configuration is invalid: ' + (error instanceof Error ? error.message : String(error)))
    runtime = undefined
  }
  tray = new Tray(icon())
  const showTrayMenu = async () => {
    if (runtime === undefined) { openInstaller(); return }
    try { await syncSupervisorStatus() }
    catch (error) { console.error('[plus-desktop] tray status refresh failed', error); supervisorSnapshot = undefined; refreshTray() }
    tray.popUpContextMenu(trayMenu)
  }
  tray.on('click', () => { void showTrayMenu() })
  tray.on('right-click', () => { void showTrayMenu() })
  refreshTray()
  if (runtime === undefined) openInstaller()
  else void syncSupervisorStatus().catch(error => {
    console.error('[plus-desktop] initial Supervisor status failed', error)
    supervisorSnapshot = undefined
    refreshTray()
  })
})
