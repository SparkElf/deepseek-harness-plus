import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { HarnessDaemon } from './daemon.mjs'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const rendererPath = join(currentDirectory, '..', 'renderer', 'index.html')
const setupPath = () => join(app.getPath('userData'), 'setup.json')
const repository = 'https://github.com/SparkElf/deepseek-harness-plus.git'
let window
let tray
let setup

function quote(value) {
  return JSON.stringify(value)
}

function settingsDocument(config) {
  return [
    'agent-default-model:',
    '  provider: ' + quote('deepseek-official'),
    '  model: ' + quote(config.model),
    ...(config.reasoningEffort ? ['  reasoningEffort: ' + quote(config.reasoningEffort)] : []),
    '',
  ].join('\n')
}

function run(command, args, cwd, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const capture = (chunk) => {
      output += chunk.toString()
      const line = chunk.toString().trim()
      if (line) onProgress(line)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', (error) => reject(new Error(command + ' could not start: ' + error.message)))
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(output || command + ' failed with exit code ' + String(code))))
  })
}

async function assertSetupInput(config) {
  if (!config.installPath || !config.workspacePath || !config.apiKey || !config.model) throw new Error('Complete every required field before continuing.')
  const port = Number(config.port)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a local port between 1024 and 65535.')
  try {
    const workspace = await stat(config.workspacePath)
    if (!workspace.isDirectory()) throw new Error('Workspace is not a directory.')
  } catch {
    throw new Error('Choose an existing workspace directory.')
  }
  await mkdir(config.installPath, { recursive: true })
  if ((await readdir(config.installPath)).length) throw new Error('Choose an empty installation directory.')
}

function icon() {
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNiIgZmlsbD0iIzExMTMxOCIvPjxjaXJjbGUgY3g9IjE2IiBjeT0iMTYiIHI9IjciIGZpbGw9IiNmZmYiLz48L3N2Zz4=')
}

function send(channel, payload) {
  window?.webContents.send(channel, payload)
}

const daemon = new HarnessDaemon((status) => {
  refreshTray()
  send('service:status', status)
})

function openWindow() {
  if (window) {
    window.show()
    window.focus()
    return
  }
  window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#f4f6f9',
    title: 'DeepSeek Harness Plus',
    webPreferences: { preload: join(currentDirectory, 'preload.mjs'), contextIsolation: true, sandbox: true },
  })
  window.loadFile(rendererPath)
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (app.quitting) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => { window = undefined })
}

function refreshTray() {
  if (!tray) return
  const running = daemon.status() === 'running'
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DeepSeek Harness Plus', click: openWindow },
    { type: 'separator' },
    { label: running ? 'Service running' : 'Service stopped', enabled: false },
    { label: 'Start service', enabled: !running && Boolean(setup), click: () => daemon.start().catch((error) => send('service:status', { state: 'error', message: error.message })) },
    { label: 'Stop service', enabled: running, click: () => daemon.stop() },
    { label: 'Open local UI', enabled: running, click: () => shell.openExternal('http://127.0.0.1:' + String(setup.port)) },
    { label: 'Open logs', enabled: Boolean(setup), click: () => shell.openPath(join(setup.installPath, '.dsh-plus', 'logs')) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quitting = true; daemon.stop(); app.quit() } },
  ]))
}

async function loadSetup() {
  try {
    setup = JSON.parse(await readFile(setupPath(), 'utf8'))
    daemon.configure(setup)
  } catch {
    setup = undefined
  }
}

app.whenReady().then(async () => {
  await loadSetup()
  tray = new Tray(icon())
  tray.setToolTip('DeepSeek Harness Plus')
  tray.on('click', openWindow)
  refreshTray()
  openWindow()
})

// The tray remains the process owner after its setup window is hidden.
app.on('window-all-closed', () => undefined)

ipcMain.handle('setup:current', () => ({ setup: setup ? { ...setup, apiKey: undefined } : undefined, service: daemon.status() }))
ipcMain.handle('dialog:directory', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
  return result.canceled ? undefined : result.filePaths[0]
})
ipcMain.handle('setup:install', async (_event, form) => {
  await assertSetupInput(form)
  const config = { ...form, port: Number(form.port), mode: 'code', dshHome: join(form.installPath, '.dsh-plus', 'home'), envPath: join(form.installPath, '.dsh-plus', 'home', '.env') }
  const progress = (message) => send('setup:progress', { message })
  progress('Checking the local Git and pnpm tools...')
  await run('git', ['--version'], undefined, progress)
  await run('pnpm', ['--version'], undefined, progress)
  progress('Cloning DeepSeek Harness Plus...')
  await run('git', ['clone', '--depth', '1', repository, form.installPath], undefined, progress)
  progress('Installing locked dependencies...')
  await run('pnpm', ['install', '--frozen-lockfile'], form.installPath, progress)
  progress('Building the local runtime...')
  await run('pnpm', ['run', 'build'], form.installPath, progress)
  await mkdir(config.dshHome, { recursive: true })
  await mkdir(join(form.installPath, '.dsh-plus', 'logs'), { recursive: true })
  await writeFile(join(config.dshHome, 'settings.yaml'), settingsDocument(config), { mode: 0o600 })
  await writeFile(config.envPath, 'DEEPSEEK_API_KEY=' + form.apiKey + '\n', { mode: 0o600 })
  try {
    await chmod(config.envPath, 0o600)
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
  delete config.apiKey
  setup = config
  await mkdir(dirname(setupPath()), { recursive: true })
  await writeFile(setupPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  daemon.configure(config)
  refreshTray()
  if (form.startAfterInstall) await daemon.start()
  return { setup: { ...config, apiKey: undefined }, service: daemon.status() }
})
ipcMain.handle('service:start', async () => { await daemon.start(); return daemon.status() })
ipcMain.handle('service:stop', () => { daemon.stop(); return daemon.status() })
ipcMain.handle('service:open', () => { if (!setup) throw new Error('Complete setup before opening the local UI.'); return shell.openExternal('http://127.0.0.1:' + String(setup.port)) })
