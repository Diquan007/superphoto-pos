// Brug tussen het kassascherm en Windows (alleen deze functies zijn beschikbaar)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pos', {
  store: {
    get: (name, fallback) => ipcRenderer.invoke('store:get', name, fallback),
    set: (name, value) => ipcRenderer.invoke('store:set', name, value)
  },
  printers: () => ipcRenderer.invoke('print:list'),
  printReceipt: (html, widthMm, printer) => ipcRenderer.invoke('print:receipt', { html, widthMm, printer }),
  appInfo: () => ipcRenderer.invoke('app:info'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  setUpdateSource: repo => ipcRenderer.invoke('update:source', repo),
  onUpdate: cb => ipcRenderer.on('update', (_e, d) => cb(d)),
  onCloseRequest: cb => ipcRenderer.on('app:close-request', () => cb()),
  closeApp: () => ipcRenderer.invoke('app:close')
});
