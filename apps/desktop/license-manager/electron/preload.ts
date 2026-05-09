import { ipcRenderer, contextBridge } from 'electron'

contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...listenerArgs) => listener(event, ...listenerArgs))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...rest] = args
    return ipcRenderer.off(channel, ...rest)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...rest] = args
    return ipcRenderer.send(channel, ...rest)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...rest] = args
    return ipcRenderer.invoke(channel, ...rest)
  },
})

contextBridge.exposeInMainWorld('api', {
  getLicensingOverview() {
    return ipcRenderer.invoke('get-licensing-overview')
  },
  issueLicense(payload: {
    deviceCode: string
    planId: string
  }) {
    return ipcRenderer.invoke('issue-license', payload)
  },
  minimizeWindow() {
    return ipcRenderer.invoke('window-minimize')
  },
  toggleMaximizeWindow() {
    return ipcRenderer.invoke('window-maximize-toggle')
  },
  closeWindow() {
    return ipcRenderer.invoke('window-close')
  },
  isWindowMaximized() {
    return ipcRenderer.invoke('window-is-maximized')
  },
})
