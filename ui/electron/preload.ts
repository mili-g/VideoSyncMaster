import { ipcRenderer, contextBridge } from 'electron'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },

  // You can expose other APTs you need here.
  // ...
})

contextBridge.exposeInMainWorld('api', {
  getFileUrl(filePath: string) {
    return ipcRenderer.invoke('get-file-url', filePath)
  },
  saveFile(filePath: string, content: string) {
    return ipcRenderer.invoke('save-file', filePath, content)
  },
  ensureDir(dirPath: string) {
    return ipcRenderer.invoke('ensure-dir', dirPath)
  },
  deletePath(targetPath: string) {
    return ipcRenderer.invoke('delete-path', targetPath)
  },
  checkFileExists(filePath: string) {
    return ipcRenderer.invoke('check-file-exists', filePath)
  },
  getPaths() {
    return ipcRenderer.invoke('get-paths')
  },
  async runBackend(args: string[], options?: { lane?: 'default' | 'prep' }) {
    const result = await ipcRenderer.invoke('run-backend', {
      args,
      lane: options?.lane || 'default'
    })
    if (result && typeof result === 'object' && (result as { canceled?: boolean }).canceled) {
      const error = Object.assign(new Error((result as { error?: string }).error || 'Task canceled by user'), {
        canceled: true,
        code: 'BACKEND_CANCELED',
      })
      throw error
    }
    return result
  },
  analyzeVideoMetadata(filePath: string) {
    return ipcRenderer.invoke('analyze-video-metadata', filePath)
  },
  cacheVideo(filePath: string) {
    return ipcRenderer.invoke('cache-video', filePath)
  },
  openFolder(filePath: string) {
    return ipcRenderer.invoke('open-folder', filePath)
  },
  openExternal(filePath: string) {
    return ipcRenderer.invoke('open-external', filePath)
  },
  openBackendLog() {
    return ipcRenderer.invoke('open-backend-log')
  },
  killBackend() {
    return ipcRenderer.invoke('kill-backend')
  },
  fixPythonEnv() {
    return ipcRenderer.invoke('fix-python-env')
  },
  checkPythonEnv() {
    return ipcRenderer.invoke('check-python-env')
  },
  checkModelStatus() {
    return ipcRenderer.invoke('check-model-status')
  },
  downloadModel(payload: { key: string; model: string; localDir: string }) {
    return ipcRenderer.invoke('download-model', payload)
  },
  downloadFile(payload: { key: string; url: string; targetDir: string; name: string }) {
    return ipcRenderer.invoke('download-file', payload)
  },
  cancelDownload(payload: { key: string }) {
    return ipcRenderer.invoke('cancel-download', payload)
  },
  cancelFileDownload(payload: { key: string }) {
    return ipcRenderer.invoke('cancel-file-download', payload)
  },
  openFileDialog(options: unknown) {
    return ipcRenderer.invoke('dialog:openFile', options)
  },
  showSaveDialog(options: unknown) {
    return ipcRenderer.invoke('dialog:showSaveDialog', options)
  },
  onBackendProgress(listener: (value: unknown) => void) {
    const wrapped = (_event: unknown, value: unknown) => listener(value)
    ipcRenderer.on('backend-progress', wrapped)
    return () => ipcRenderer.off('backend-progress', wrapped)
  },
  onBackendStage(listener: (data: unknown) => void) {
    const wrapped = (_event: unknown, data: unknown) => listener(data)
    ipcRenderer.on('backend-stage', wrapped)
    return () => ipcRenderer.off('backend-stage', wrapped)
  },
  onBackendIssue(listener: (data: unknown) => void) {
    const wrapped = (_event: unknown, data: unknown) => listener(data)
    ipcRenderer.on('backend-issue', wrapped)
    return () => ipcRenderer.off('backend-issue', wrapped)
  },
  onBackendPartialResult(listener: (data: unknown) => void) {
    const wrapped = (_event: unknown, data: unknown) => listener(data)
    ipcRenderer.on('backend-partial-result', wrapped)
    return () => ipcRenderer.off('backend-partial-result', wrapped)
  },
  onBackendDepsInstalling(listener: (pkgName: string) => void) {
    const wrapped = (_event: unknown, pkgName: string) => listener(pkgName)
    ipcRenderer.on('backend-deps-installing', wrapped)
    return () => ipcRenderer.off('backend-deps-installing', wrapped)
  },
  onBackendDepsDone(listener: () => void) {
    const wrapped = () => listener()
    ipcRenderer.on('backend-deps-done', wrapped)
    return () => ipcRenderer.off('backend-deps-done', wrapped)
  },
  onMainProcessMessage(listener: (message: string) => void) {
    const wrapped = (_event: unknown, message: string) => listener(message)
    ipcRenderer.on('main-process-message', wrapped)
    return () => ipcRenderer.off('main-process-message', wrapped)
  },
})
