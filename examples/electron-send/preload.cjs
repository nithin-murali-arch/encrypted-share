const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('transfer', {
  pickFile: () => ipcRenderer.invoke('transfer:pick'),
  send: ({ host, port, password }) => ipcRenderer.invoke('transfer:send', { host, port, password }),
  onProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('transfer:progress', listener);
    return () => ipcRenderer.removeListener('transfer:progress', listener);
  },
});
