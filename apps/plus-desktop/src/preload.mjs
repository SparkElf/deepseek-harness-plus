import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('plusDesktop', {
  current: () => ipcRenderer.invoke('setup:current'),
  chooseDirectory: () => ipcRenderer.invoke('dialog:directory'),
  install: (form) => ipcRenderer.invoke('setup:install', form),
  start: () => ipcRenderer.invoke('service:start'),
  stop: () => ipcRenderer.invoke('service:stop'),
  open: () => ipcRenderer.invoke('service:open'),
  onProgress: (listener) => ipcRenderer.on('setup:progress', (_event, value) => listener(value)),
  onServiceStatus: (listener) => ipcRenderer.on('service:status', (_event, value) => listener(value)),
})
