import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args),
    invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
    on: (channel: string, func: (...args: any[]) => void) => ipcRenderer.on(channel, (_event, ...args) => func(...args)),
    removeListener: (channel: string, func: (...args: any[]) => void) => ipcRenderer.removeListener(channel, func),
  }
})