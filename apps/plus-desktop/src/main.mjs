import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { HarnessDaemon } from './daemon.mjs'

const repository = 'https://github.com/SparkElf/deepseek-harness-plus.git'
const currentDirectory = dirname(fileURLToPath(import.meta.url))
const setupPath = () => join(app.getPath('userData'), 'runtime.json')
let tray
let installerWindow
let runtime
let busy
let status = { state: 'stopped', message: 'Service stopped.' }

function icon() {
  return nativeImage.createFromPath(join(currentDirectory, '..', 'build', 'icon.png'))
}

function settingsDocument(form) {
  return [
    'agent-default-model:',
    '  provider: "deepseek-official"',
    '  model: ' + JSON.stringify(form.model),
    ...(form.reasoningEffort ? ['  reasoningEffort: ' + JSON.stringify(form.reasoningEffort)] : []),
    '',
  ].join('\n')
}

function run(command, args, cwd, report) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const capture = (chunk) => {
      output += chunk.toString()
      const message = chunk.toString().trim()
      if (message) report(message)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', (error) => reject(new Error(command + ' could not start: ' + error.message)))
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(output || command + ' failed with exit code ' + String(code))))
  })
}

async function assertEmptyDirectory(path) {
  await mkdir(path, { recursive: true })
  if ((await readdir(path)).length) throw new Error('Choose an empty installation directory.')
}

async function assertInstalled() {
  if (runtime === undefined) throw new Error('Install DeepSeek Harness Plus before using this action.')
  const installation = await stat(runtime.installPath)
  if (!installation.isDirectory()) throw new Error('The configured installation directory is unavailable.')
}

async function saveRuntime(next) {
  await mkdir(dirname(setupPath()), { recursive: true })
  await writeFile(setupPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  runtime = next
  daemon.configure(next)
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
    minWidth: 820,
    minHeight: 620,
    show: false,
    backgroundColor: '#f4f6f9',
    title: 'Install DeepSeek Harness Plus',
    webPreferences: {
      preload: join(currentDirectory, 'preload.mjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  installerWindow.loadFile(join(currentDirectory, '..', 'renderer', 'index.html'))
  installerWindow.once('ready-to-show', () => installerWindow?.show())
  installerWindow.on('closed', () => { installerWindow = undefined })
}

function refreshTray() {
  if (tray === undefined) return
  const running = daemon.status() === 'running'
  const maintenanceBusy = busy !== undefined
  tray.setToolTip('DeepSeek Harness Plus: ' + (busy ?? status.message))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DeepSeek Harness', enabled: runtime !== undefined && running, click: openWeb },
    { label: running ? 'Service running' : 'Service stopped', enabled: false },
    { label: 'Start service', enabled: runtime !== undefined && !running && !maintenanceBusy, click: () => action('Starting local service...', () => daemon.start()) },
    { label: 'Stop service', enabled: running && !maintenanceBusy, click: () => action('Stopping local service...', () => daemon.stop()) },
    { type: 'separator' },
    { label: 'Install Plus...', enabled: runtime === undefined && !maintenanceBusy, click: openInstaller },
    { label: 'Upgrade Plus', enabled: runtime !== undefined && !maintenanceBusy, click: () => upgrade() },
    { label: 'Repair installation', enabled: runtime !== undefined && !maintenanceBusy, click: () => repair() },
    { label: 'Open local data folder', enabled: runtime !== undefined && !maintenanceBusy, click: () => shell.openPath(join(runtime.installPath, '.dsh-plus')) },
    { type: 'separator' },
    { label: 'Quit', click: async () => { await daemon.stop(); app.quit() } },
  ]))
}

async function action(label, work) {
  busy = label
  refreshTray()
  try {
    await work()
  } catch (error) {
    dialog.showErrorBox('DeepSeek Harness Plus', error instanceof Error ? error.message : String(error))
  } finally {
    busy = undefined
    refreshTray()
  }
}

async function install(form) {
  if (runtime !== undefined) throw new Error('DeepSeek Harness Plus is already installed.')
  if (!form.installPath || !form.apiKey || !form.model) throw new Error('Choose an installation directory and provide a DeepSeek key and default model.')
  const port = Number(form.port)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a local port between 1024 and 65535.')
  busy = 'Installing DeepSeek Harness Plus...'
  refreshTray()
  try {
    const report = (message) => {
      status = { state: 'working', message }
      sendInstaller('install:progress', { message })
      refreshTray()
    }
    report('Checking Git and pnpm...')
    await run('git', ['--version'], undefined, report)
    await run('pnpm', ['--version'], undefined, report)
    await assertEmptyDirectory(form.installPath)
    report('Cloning DeepSeek Harness Plus...')
    await run('git', ['clone', '--depth', '1', repository, form.installPath], undefined, report)
    const dshHome = join(form.installPath, '.dsh-plus', 'home')
    await mkdir(join(form.installPath, '.dsh-plus', 'logs'), { recursive: true })
    await mkdir(dshHome, { recursive: true })
    await writeFile(join(dshHome, 'settings.yaml'), settingsDocument(form), { mode: 0o600 })
    await writeFile(join(dshHome, '.env'), 'DEEPSEEK_API_KEY=' + form.apiKey + '\n', { mode: 0o600 })
    await saveRuntime({ installPath: form.installPath, dshHome, port, mode: 'code' })
    report('Installing locked dependencies...')
    await run('pnpm', ['install', '--frozen-lockfile'], form.installPath, report)
    report('Building the local runtime...')
    await run('pnpm', ['run', 'build'], form.installPath, report)
    await daemon.start()
    await openWeb()
    installerWindow?.close()
    return { installed: true }
  } finally {
    busy = undefined
    refreshTray()
  }
}

async function upgrade() {
  await action('Upgrading DeepSeek Harness Plus...', async () => {
    await assertInstalled()
    const restart = daemon.status() === 'running'
    if (restart) await daemon.stop()
    const report = (message) => { status = { state: 'working', message }; refreshTray() }
    await run('git', ['pull', '--ff-only'], runtime.installPath, report)
    await run('pnpm', ['install', '--frozen-lockfile'], runtime.installPath, report)
    await run('pnpm', ['run', 'build'], runtime.installPath, report)
    if (restart) await daemon.start()
  })
}

async function repair() {
  await action('Repairing DeepSeek Harness Plus...', async () => {
    await assertInstalled()
    const restart = daemon.status() === 'running'
    if (restart) await daemon.stop()
    const report = (message) => { status = { state: 'working', message }; refreshTray() }
    await run('pnpm', ['install', '--frozen-lockfile'], runtime.installPath, report)
    await run('pnpm', ['run', 'build'], runtime.installPath, report)
    if (restart) await daemon.start()
  })
}

async function openWeb() {
  await assertInstalled()
  await shell.openExternal('http://127.0.0.1:' + String(runtime.port))
}

const daemon = new HarnessDaemon((next) => {
  status = next
  refreshTray()
})

async function loadRuntime() {
  try {
    const saved = JSON.parse(await readFile(setupPath(), 'utf8'))
    runtime = saved
    daemon.configure(saved)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      runtime = undefined
      return
    }
    throw error
  }
}

ipcMain.handle('installer:choose-directory', async () => {
  const result = await dialog.showOpenDialog(installerWindow, {
    title: 'Choose an empty folder for DeepSeek Harness Plus',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? undefined : result.filePaths[0]
})
ipcMain.handle('installer:install', (_event, form) => install(form))

app.whenReady().then(async () => {
  try {
    await loadRuntime()
  } catch (error) {
    dialog.showErrorBox('DeepSeek Harness Plus', 'The saved tray runtime configuration is invalid: ' + (error instanceof Error ? error.message : String(error)))
    runtime = undefined
  }
  tray = new Tray(icon())
  tray.on('click', () => runtime === undefined ? openInstaller() : action('Opening DeepSeek Harness...', openWeb))
  refreshTray()
  openInstaller()
})
