import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('plusInstaller', {
  platform: process.platform,
  chooseDirectory: (target) => ipcRenderer.invoke('installer:choose-directory', target),
  listWslDistributions: () => ipcRenderer.invoke('installer:list-wsl-distributions'),
  install: (form) => ipcRenderer.invoke('installer:install', form),
  applyAppearance: (appearance) => ipcRenderer.invoke('installer:apply-appearance', appearance),
  windowControl: (command) => ipcRenderer.invoke('installer:window-control', command),
  onProgress: (listener) => ipcRenderer.on('install:progress', (_event, value) => listener(value)),
})
