const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('photomark', {
  init: () => ipcRenderer.invoke('app:init'),
  chooseDirectory: kind => ipcRenderer.invoke('directory:choose', kind),
  scan: (source, recursive) => ipcRenderer.invoke('directory:scan', source, recursive),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  preview: (file, settings, original, fullResolution) => ipcRenderer.invoke('image:preview', file, settings, original, fullResolution),
  restoreJob: () => ipcRenderer.invoke('job:restore'),
  start: (source, output, settings) => ipcRenderer.invoke('batch:start', source, output, settings),
  pause: () => ipcRenderer.invoke('batch:pause'),
  openOutput: () => ipcRenderer.invoke('directory:open'),
  exportErrors: () => ipcRenderer.invoke('errors:export'),
  onProgress: handler => ipcRenderer.on('batch:progress', (_, value) => handler(value)),
  onClosing: handler => ipcRenderer.on('app:closing', handler),
});
