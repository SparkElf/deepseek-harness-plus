/** Optional Electron tray for one configured Plus Supervisor. */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSupervisorManifest } from '@sparkelf/dsh-plugin-supervisor/manifest'
import { sendSupervisorCommand, supervisorAvailable, waitForSupervisor } from '@sparkelf/dsh-plugin-supervisor/client'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const iconPath = join(currentDirectory, '..', 'build', 'icon.png')
const supervisorEntry = fileURLToPath(import.meta.resolve('@sparkelf/dsh-plugin-supervisor/bin'))

/**
 * 把Plus tray挂载到调用方持有的Electron host；Desktop只委托Supervisor command。
 * @param {object} electron - caller-owned Electron module.
 * @param {{ manifestPath?: string }} [options] - Supervisor manifest selection.
 * @returns {Promise<{ tray: object, supervisorProcess: object | undefined }>} mounted tray and launched process.
 */
export async function runPlusDesktop(electron, options = {}) {
  const { app, dialog, Menu, nativeImage, shell, Tray } = electron
  const manifestPath = options.manifestPath ?? join(homedir(), '.dsh', 'supervisor', 'runtime.json')
  await app.whenReady()
  const zh = app.getLocale().toLowerCase().startsWith('zh')
  const copy = zh ? {
    title: 'DeepSeek Harness Plus',
    openHarness: '打开 Harness',
    openSupervisor: '打开 Supervisor',
    start: '启动',
    stop: '停止',
    restart: '重启',
    rebuild: '构建并重启',
    quit: '退出桌面程序',
    running: 'Harness 运行中',
    stopped: 'Harness 已停止',
    failed: 'Supervisor 操作失败',
  } : {
    title: 'DeepSeek Harness Plus',
    openHarness: 'Open Harness',
    openSupervisor: 'Open Supervisor',
    start: 'Start',
    stop: 'Stop',
    restart: 'Restart',
    rebuild: 'Build and restart',
    quit: 'Quit Desktop',
    running: 'Harness running',
    stopped: 'Harness stopped',
    failed: 'Supervisor operation failed',
  }

  const manifest = await readSupervisorManifest(manifestPath)
  let supervisorProcess
  let status
  if (await supervisorAvailable(manifest.socketPath)) {
    status = await sendSupervisorCommand(manifest.socketPath, 'status')
  } else {
    supervisorProcess = spawn(process.execPath, [supervisorEntry, '--manifest', manifestPath], {
      detached: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
      windowsHide: true,
    })
    supervisorProcess.unref()
    status = await waitForSupervisor(manifest.socketPath)
  }

  const tray = new Tray(nativeImage.createFromPath(iconPath))
  tray.setTitle(copy.title)

  async function run(command) {
    try {
      status = await sendSupervisorCommand(manifest.socketPath, command)
      refreshMenu()
    } catch (error) {
      console.error('[plus-desktop] Supervisor command failed', error)
      dialog.showErrorBox(copy.failed, error instanceof Error ? error.stack ?? error.message : String(error))
    }
  }

  function refreshMenu() {
    const running = status?.state === 'running'
    tray.setToolTip(copy.title + ' · ' + (running ? copy.running : copy.stopped))
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: copy.openHarness, enabled: running, click: () => { void shell.openExternal('http://127.0.0.1:' + String(manifest.port)) } },
      { label: copy.openSupervisor, click: () => { void shell.openExternal('http://127.0.0.1:' + String(manifest.supervisorPort)) } },
      { type: 'separator' },
      { label: copy.start, enabled: !running, click: () => { void run('start') } },
      { label: copy.stop, enabled: running, click: () => { void run('stop') } },
      { label: copy.restart, enabled: running, click: () => { void run('restart') } },
      { label: copy.rebuild, enabled: manifest.build !== undefined, click: () => { void run('rebuild-and-restart') } },
      { type: 'separator' },
      { label: copy.quit, click: () => { app.quit() } },
    ]))
  }

  refreshMenu()
  return { tray, supervisorProcess }
}
