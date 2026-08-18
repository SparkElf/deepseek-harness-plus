import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('plusInstaller', {
  platform: process.platform,
  defaultInstallPath: () => ipcRenderer.invoke('installer:default-install-path'),
  reconfigureState: () => ipcRenderer.invoke('installer:reconfigure-state'),
  listDirectories: (target, path) => ipcRenderer.invoke('installer:list-directories', target, path),
  createDirectory: (target, path, name) => ipcRenderer.invoke('installer:create-directory', target, path, name),
  selectDirectory: (target, path) => ipcRenderer.invoke('installer:select-directory', target, path),
  listWslDistributions: () => ipcRenderer.invoke('installer:list-wsl-distributions'),
  install: (form) => ipcRenderer.invoke('installer:install', form),
  applyAppearance: (appearance) => ipcRenderer.invoke('installer:apply-appearance', appearance),
  onProgress: (listener) => ipcRenderer.on('install:progress', (_event, value) => listener(value)),
})

contextBridge.exposeInMainWorld('plusUpdates', {
  list: () => ipcRenderer.invoke('updates:list'),
  upgrade: (sourceRef) => ipcRenderer.invoke('updates:upgrade', sourceRef),
  aiMerge: (sourceRef) => ipcRenderer.invoke('updates:ai-merge', sourceRef),
  onProgress: listener => ipcRenderer.on('updates:progress', (_event, value) => listener(value)),
})

contextBridge.exposeInMainWorld('plusBackup', {
  state: () => ipcRenderer.invoke('backup:state'),
  exportArchive: (options) => ipcRenderer.invoke('backup:export', options),
  importArchive: (options) => ipcRenderer.invoke('backup:import', options),
})
