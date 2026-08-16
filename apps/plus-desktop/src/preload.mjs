import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('plusInstaller', {
  platform: process.platform,
  listDirectories: (target, path) => ipcRenderer.invoke('installer:list-directories', target, path),
  createDirectory: (target, path, name) => ipcRenderer.invoke('installer:create-directory', target, path, name),
  selectDirectory: (target, path) => ipcRenderer.invoke('installer:select-directory', target, path),
  listWslDistributions: () => ipcRenderer.invoke('installer:list-wsl-distributions'),
  install: (form) => ipcRenderer.invoke('installer:install', form),
  applyAppearance: (appearance) => ipcRenderer.invoke('installer:apply-appearance', appearance),
  windowControl: (command) => ipcRenderer.invoke('installer:window-control', command),
  onProgress: (listener) => ipcRenderer.on('install:progress', (_event, value) => listener(value)),
})
