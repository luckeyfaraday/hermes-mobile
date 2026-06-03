const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hermesHost', {
  configureServe: () => ipcRenderer.invoke('tailscale:serve'),
  openDownload: () => ipcRenderer.invoke('tailscale:open-download'),
  openUrl: url => ipcRenderer.invoke('url:open', url),
  readStatus: () => ipcRenderer.invoke('status:read'),
  saveBackend: payload => ipcRenderer.invoke('backend:save', payload)
})
