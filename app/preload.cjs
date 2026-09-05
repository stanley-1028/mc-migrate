const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  pickFiles: () => ipcRenderer.invoke('file:pick'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  listVersions: () => ipcRenderer.invoke('versions:list'),
  listModels: (provider, apiKey) => ipcRenderer.invoke('models:list', { provider, apiKey }),
  openFolder: (p) => ipcRenderer.invoke('folder:open', p),
  run: (params) => ipcRenderer.invoke('run', params),
  cancel: () => ipcRenderer.invoke('run:cancel'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: (url, version) => ipcRenderer.invoke('update:install', url, version),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (e, data) => cb(data)),
  saveArtifact: (kind, filePath) => ipcRenderer.invoke('artifact:save', { kind, filePath }),
  onProgress: (cb) => ipcRenderer.on('progress', (e, data) => cb(data)),
});
