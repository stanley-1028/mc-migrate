const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  openFolder: (p) => ipcRenderer.invoke('folder:open', p),
  run: (params) => ipcRenderer.invoke('run', params),
  saveArtifact: (kind, filePath) => ipcRenderer.invoke('artifact:save', { kind, filePath }),
  onProgress: (cb) => ipcRenderer.on('progress', (e, data) => cb(data)),
});
