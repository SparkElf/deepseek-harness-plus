import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('plusInstaller', {
  chooseDirectory: () => ipcRenderer.invoke('installer:choose-directory'),
  install: (form) => ipcRenderer.invoke('installer:install', form),
  onProgress: (listener) => ipcRenderer.on('install:progress', (_event, value) => listener(value)),
})
