import { app, BrowserWindow, ipcMain, shell, dialog, screen } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { spawn, exec, execFile, ChildProcess } from 'child_process'
import fs from 'fs'

const activeDownloads = new Map<string, ChildProcess>();
const VERBOSE_MAIN_LOGS = process.env.VSM_VERBOSE_MAIN === '1'

type MainLogLevel = 'info' | 'warn' | 'error' | 'debug'
type MainLogType = 'business' | 'error' | 'security' | 'debug'
type FileSystemError = NodeJS.ErrnoException | null
type ProcessChunk = string | Buffer | Uint8Array

interface MainLogFields {
  domain: string
  action?: string
  event?: string
  stage?: string
  code?: string
  detail?: string
}

function emitMainLog(level: MainLogLevel, logType: MainLogType, message: string, fields: MainLogFields) {
  if (level === 'debug' && !VERBOSE_MAIN_LOGS) {
    return
  }

  const toConsoleSafeString = (value: string | undefined) => {
    const text = String(value || '')
    if (process.platform !== 'win32') {
      return text
    }
    return text.replace(/[^\x20-\x7E]/g, (char) => {
      const code = char.charCodeAt(0).toString(16).padStart(4, '0')
      return `\\u${code}`
    })
  }

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    logger: 'electron.main',
    domain: fields.domain,
    log_type: logType,
    message: toConsoleSafeString(message),
    action: fields.action || '-',
    event: toConsoleSafeString(fields.event),
    stage: toConsoleSafeString(fields.stage),
    code: toConsoleSafeString(fields.code),
    detail: toConsoleSafeString(fields.detail)
  }

  const line = `__MAIN_LOG__${JSON.stringify(payload)}`
  if (level === 'error') {
    console.error(line)
    return
  }
  if (level === 'warn') {
    console.warn(line)
    return
  }
  console.log(line)
}

function logMainBusiness(message: string, fields: MainLogFields) {
  emitMainLog('info', 'business', message, fields)
}

function logMainWarn(message: string, fields: MainLogFields) {
  emitMainLog('warn', 'business', message, fields)
}

function logMainSecurity(message: string, fields: MainLogFields) {
  emitMainLog('warn', 'security', message, fields)
}

function logMainError(message: string, fields: MainLogFields) {
  emitMainLog('error', 'error', message, fields)
}

function logMainDebug(message: string, fields: MainLogFields) {
  emitMainLog('debug', 'debug', message, fields)
}

logMainDebug('Main process initialized', { domain: 'bootstrap', action: 'startup' })
process.on('uncaughtException', (error) => {
  logMainError('Main process uncaught exception', {
    domain: 'bootstrap',
    action: 'uncaughtException',
    detail: error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error)
  })
});

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { path7za } = require('7zip-bin') as { path7za: string }

// The built directory structure
process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null
type BackendLane = 'default' | 'prep'

interface ActiveBackendRequest {
  requestId: string
  sender: Electron.WebContents
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  cancellationState: { requested: boolean }
  outputData: string
  errorData: string
}

interface BackendWorkerState {
  process: ChildProcess | null
  activeCancellation: { requested: boolean } | null
  runQueue: Promise<unknown>
  stdoutBuffer: string
  stderrBuffer: string
  requestCounter: number
  activeRequest: ActiveBackendRequest | null
  launchEnvOverrides: Record<string, string>
  fatalCudaRestartCount: number
}

const backendWorkers: Record<BackendLane, BackendWorkerState> = {
  default: {
    process: null,
    activeCancellation: null,
    runQueue: Promise.resolve(),
    stdoutBuffer: '',
    stderrBuffer: '',
    requestCounter: 0,
    activeRequest: null,
    launchEnvOverrides: {},
    fatalCudaRestartCount: 0
  },
  prep: {
    process: null,
    activeCancellation: null,
    runQueue: Promise.resolve(),
    stdoutBuffer: '',
    stderrBuffer: '',
    requestCounter: 0,
    activeRequest: null,
    launchEnvOverrides: {},
    fatalCudaRestartCount: 0
  }
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false })
const gbkDecoder = new TextDecoder('gbk', { fatal: false })
// Keep cache sessions for a while so interrupted jobs can resume after app restart.
const CACHE_RETENTION_DAYS = 7
const CACHE_RETENTION_MS = CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000

function countReplacementChars(value: string) {
  return (value.match(/\uFFFD/g) || []).length
}

function decodeProcessChunk(data: ProcessChunk) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const utf8Text = utf8Decoder.decode(buffer)

  if (process.platform !== 'win32') {
    return utf8Text
  }

  const gbkText = gbkDecoder.decode(buffer)
  const utf8Bad = countReplacementChars(utf8Text)
  const gbkBad = countReplacementChars(gbkText)

  if (utf8Bad === 0) {
    return utf8Text
  }

  if (gbkBad < utf8Bad) {
    return gbkText
  }

  if ((utf8Text.includes('\uFFFD\uFFFD\uFFFD\uFFFD') || utf8Bad > 0) && /sox/i.test(gbkText)) {
    return gbkText
  }

  return utf8Text
}

function normalizeKnownProcessMessage(message: string) {
  if (!message) return message

  if (
    process.platform === 'win32' &&
    /'sox'.*不是内部或外部命令，也不是可运行的程序或批处理文件。?/i.test(message)
  ) {
    return `'sox' is not recognized as an internal or external command, operable program or batch file.`
  }

  return message
}

function extractModelDownloadProgress(message: string) {
  if (!message) return null

  const explicitMatch = message.match(/PROGRESS:(\d{1,3})(?::([^\r\n]+))?/)
  if (explicitMatch) {
    const explicitMessage = explicitMatch[2]?.trim() || '下载中'
    const explicitPhase = /解压/i.test(explicitMessage)
      ? 'extracting'
      : /安装/i.test(explicitMessage)
        ? 'installing'
      : /准备|开始/i.test(explicitMessage)
        ? 'preparing'
        : /完成/i.test(explicitMessage)
          ? 'completed'
          : 'downloading'
    return {
      percent: Number(explicitMatch[1]),
      phase: explicitPhase as 'preparing' | 'downloading' | 'extracting' | 'installing' | 'completed',
      message: explicitMessage
    }
  }

  const fileMatch = message.match(/Downloading \[([^\]]+)\]:\s+(\d{1,3})%/i)
  if (fileMatch) {
    return {
      percent: Number(fileMatch[2]),
      phase: 'downloading' as const,
      message: `${fileMatch[1].trim()} | 下载中 ${fileMatch[2]}%`
    }
  }

  const processingMatch = message.match(/Processing\s+\d+(?:\.\d+)?\s+items:\s+(\d{1,3})%/i)
  if (processingMatch) {
    return {
      percent: Number(processingMatch[1]),
      phase: 'preparing' as const,
      message: `整理下载任务 ${processingMatch[1]}%`
    }
  }

  return null
}

function emitModelDownloadProgress(
  sender: Electron.WebContents,
  key: string,
  progress: {
    percent?: number
    phase?: 'preparing' | 'downloading' | 'extracting' | 'installing' | 'completed' | 'failed' | 'canceled'
    message?: string
  }
) {
  sender.send('model-download-progress', {
    key,
    percent: progress.percent,
    phase: progress.phase,
    message: progress.message
  })
}

function findFileInRoots(searchRoots: string[], candidateNames: string[]) {
  for (const root of searchRoots) {
    if (!root || !fs.existsSync(root)) continue
    for (const candidateName of candidateNames) {
      const directCandidate = path.join(root, candidateName)
      if (fs.existsSync(directCandidate)) {
        return directCandidate
      }
    }
    if (!fs.statSync(root).isDirectory()) continue
    const pendingDirs = [root]
    while (pendingDirs.length > 0) {
      const currentDir = pendingDirs.shift()
      if (!currentDir) continue
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name)
        if (entry.isFile() && candidateNames.includes(entry.name)) {
          return fullPath
        }
        if (entry.isDirectory()) {
          pendingDirs.push(fullPath)
        }
      }
    }
  }
  return null
}

function getFasterWhisperRuntimeSearchRoots(projectRoot: string) {
  const candidates = [
    path.join(projectRoot, 'models', 'faster_whisper_runtime'),
    path.join(projectRoot, 'resources', 'media_tools', 'faster_whisper'),
    path.join(projectRoot, 'resources', 'media_tools'),
    path.join(projectRoot, 'resources'),
    projectRoot,
    path.join(projectRoot, 'resource', 'bin'),
    path.join(projectRoot, 'resource', 'bin', 'Faster-Whisper-XXL'),
    path.join(projectRoot, 'resource', 'bin', 'Faster-Whisper-XXL', 'Faster-Whisper-XXL'),
  ]

  return Array.from(new Set(candidates.map(candidate => path.resolve(candidate))))
}

function getBackendWorkerState(lane: BackendLane) {
  return backendWorkers[lane]
}

function enqueueBackendRun<T>(lane: BackendLane, runner: () => Promise<T>): Promise<T> {
  const workerState = getBackendWorkerState(lane)
  const task = workerState.runQueue.then(runner, runner)
  workerState.runQueue = task.catch(() => undefined)
  return task
}

interface BackendStructuredEvent {
  type?: string
  name?: string
  action?: string | null
  payload?: Record<string, unknown>
  context?: Record<string, unknown>
  timestamp?: string
}

interface BackendStructuredLogLine {
  timestamp?: string
  level?: string
  logger?: string
  domain?: string
  log_type?: string
  message?: string
  trace_id?: string
  request_id?: string
  action?: string
  event?: string
  stage?: string
  code?: string
  retryable?: boolean
  detail?: string
}

const BACKEND_EVENT_PREFIX = '__EVENT__'
const BACKEND_LOG_PREFIX = '__LOG__'
const BACKEND_WORKER_RESULT_PREFIX = '__WORKER_RESULT__'
const MAX_BACKEND_CAPTURE_CHARS = 200_000
const BACKEND_VERBOSE_STREAMS = process.env.VSM_VERBOSE_BACKEND === '1'

function appendCappedText(existing: string, nextLine: string) {
  const appended = `${existing}${nextLine}\n`
  if (appended.length <= MAX_BACKEND_CAPTURE_CHARS) {
    return appended
  }
  return appended.slice(appended.length - MAX_BACKEND_CAPTURE_CHARS)
}

function summarizeBackendError(errorText: string) {
  const normalized = String(errorText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (normalized.length === 0) {
    return 'No backend error details captured.'
  }

  const tail = normalized.slice(-8)
  return tail.join(' | ')
}

function shouldMirrorBackendLine(source: 'stdout' | 'stderr', line: string) {
  if (BACKEND_VERBOSE_STREAMS) {
    return true
  }

  const normalized = line.toLowerCase()
  if (source === 'stdout') {
    return normalized.includes('[progress]')
      || normalized.includes('[partial]')
      || normalized.includes('[deps_installing]')
      || normalized.includes('[deps_done]')
      || normalized.includes('[stage')
      || normalized.includes('step ')
      || normalized.includes('running ')
      || normalized.includes('synthesizing')
      || normalized.includes('aligning')
      || normalized.includes('translating')
      || normalized.includes('merging')
      || normalized.includes('reference')
      || normalized.includes('batch')
      || normalized.includes('warning')
      || normalized.includes('failed')
      || normalized.includes('error')
  }

  return normalized.includes('traceback')
    || normalized.includes('error')
    || normalized.includes('failed')
    || normalized.includes('exception')
    || normalized.includes('fatal')
    || isFatalCudaWorkerMessage(normalized)
}

function inferMirroredBackendLineLevel(
  source: 'stdout' | 'stderr',
  line: string
): 'info' | 'warn' | 'error' {
  const normalized = String(line || '').toLowerCase()
  const hasWarning = /\bwarning\b|\bwarn\b/i.test(normalized)
  const hasHardError = /\btraceback\b|\bexception\b|\bfatal\b/i.test(normalized) || isFatalCudaWorkerMessage(normalized)
  const hasExplicitFailure = /\berror\b|\bfailed\b|\bfailure\b/i.test(normalized)

  if (source === 'stdout') {
    if (hasWarning) return 'warn'
    return hasExplicitFailure || hasHardError ? 'error' : 'info'
  }

  if (hasHardError) return 'error'
  if (hasWarning) return 'warn'
  if (/^\s*(error|failed|failure)[:\s[]/i.test(line) || /^\[[^\]]+\]\s*(error|failed|failure)\b/i.test(line)) {
    return 'error'
  }

  // Many third-party libraries write normal configuration chatter to stderr.
  // Keep mirroring it for troubleshooting, but don't surface it as an issue by default.
  return 'info'
}

function parseBackendStructuredLogLine(line: string): BackendStructuredLogLine | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(BACKEND_LOG_PREFIX)) return null

  try {
    return JSON.parse(trimmed.slice(BACKEND_LOG_PREFIX.length))
  } catch (error) {
    logMainError('解析后端结构化日志失败', {
      domain: 'backend.protocol',
      action: 'parseBackendStructuredLogLine',
      detail: `${trimmed}\n${error instanceof Error ? error.message : String(error)}`
    })
    return null
  }
}

function parseBackendStructuredEvent(line: string): BackendStructuredEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(BACKEND_EVENT_PREFIX)) return null

  try {
    return JSON.parse(trimmed.slice(BACKEND_EVENT_PREFIX.length))
  } catch (error) {
    logMainError('解析后端结构化事件失败', {
      domain: 'backend.protocol',
      action: 'parseBackendStructuredEvent',
      detail: `${trimmed}\n${error instanceof Error ? error.message : String(error)}`
    })
    return null
  }
}

function dispatchBackendStructuredEvent(sender: Electron.WebContents, event: BackendStructuredEvent) {
  const payload = event.context
    ? { ...(event.payload || {}), context: event.context }
    : (event.payload || {})

  if (event.name === 'progress') {
    sender.send('backend-progress', payload)
    return true
  }

  if (event.name === 'stage') {
    sender.send('backend-stage', payload)
    return true
  }

  if (event.name === 'issue') {
    sender.send('backend-issue', payload)
    return true
  }

  if (event.name === 'partial_result') {
    sender.send('backend-partial-result', payload)
    return true
  }

  if (event.name === 'deps_installing') {
    sender.send('backend-deps-installing', payload.package || '')
    return true
  }

  if (event.name === 'deps_done') {
    sender.send('backend-deps-done')
    return true
  }

  return false
}

function dispatchBackendLogLine(
  sender: Electron.WebContents,
    payload: {
      lane: BackendLane
      source: 'stdout' | 'stderr'
      level: 'info' | 'warn' | 'error'
      logType?: 'business' | 'error' | 'security' | 'debug'
      domain?: string
      traceId?: string
      requestId?: string
      action?: string
      event?: string
      stage?: string
      code?: string
      retryable?: boolean
      detail?: string
      text: string
      timestamp: number
    }
) {
  sender.send('backend-log-line', payload)
}

function isFatalCudaWorkerMessage(message: string) {
  const normalized = String(message || '').toLowerCase()
  return normalized.includes('device-side assert triggered')
    || normalized.includes('cuda kernel errors might be asynchronously reported')
    || normalized.includes('compile with `torch_use_cuda_dsa`')
}

function restartBackendWorkerAfterFatalCuda(lane: BackendLane, message: string) {
  const workerState = getBackendWorkerState(lane)
  const backendProcess = workerState.process
  if (!backendProcess) {
    return
  }

  workerState.fatalCudaRestartCount += 1
  workerState.launchEnvOverrides = {
    ...workerState.launchEnvOverrides,
    INDEXTTS_FORCE_FP32: '1'
  }

  const resetMessage = `[BackendReset] Fatal CUDA worker error detected. Restarting worker with safer IndexTTS settings. ${message}`
  if (workerState.activeRequest) {
    workerState.activeRequest.errorData += `${resetMessage}\n`
  }
  logMainSecurity('检测到致命 CUDA 错误，重启后端工作进程', {
    domain: 'backend.worker',
    action: 'restartBackendWorkerAfterFatalCuda',
    detail: message
  })

  workerState.process = null
  terminateProcessTree(backendProcess).catch((error) => {
    logMainError('重启后端工作进程失败', {
      domain: 'backend.worker',
      action: 'restartBackendWorkerAfterFatalCuda',
      detail: `[${lane}] ${error instanceof Error ? error.message : String(error)}`
    })
  })
}

function getPythonProcessEnv() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    HF_HUB_DISABLE_XET: '1',
    NUMBA_DISABLE_INTEL_SVML: '1',
    NUMBA_CPU_NAME: 'generic'
  }

  try {
    const projectRoot = getProjectRoot()
    const sitePackages = path.join(getPythonRoot(projectRoot), 'Lib', 'site-packages')
    const torchLib = path.join(sitePackages, 'torch', 'lib')
    const cudaPaths = [
      path.join(sitePackages, 'nvidia', 'cudnn', 'bin'),
      path.join(sitePackages, 'nvidia', 'cublas', 'bin'),
      path.join(sitePackages, 'nvidia', 'cuda_runtime', 'bin'),
      path.join(sitePackages, 'nvidia', 'cuda_nvrtc', 'bin'),
      torchLib
    ].filter((candidate) => fs.existsSync(candidate))

    if (cudaPaths.length > 0) {
      env.PATH = `${cudaPaths.join(path.delimiter)}${path.delimiter}${env.PATH || ''}`
    }
  } catch (error) {
    logMainError('扩展 CUDA 运行时路径失败', {
      domain: 'runtime.env',
      action: 'getPythonProcessEnv',
      detail: error instanceof Error ? error.message : String(error)
    })
  }

  return env
}

function looksLikeProjectRoot(candidate: string) {
  const requiredMarkers = [
    path.join(candidate, 'package.json'),
    path.join(candidate, 'requirements.txt')
  ]
  if (!requiredMarkers.every(marker => fs.existsSync(marker))) {
    return false
  }

  return hasStructureMarkers(candidate, ['apps', 'services', 'docs'])
    || hasStructureMarkers(candidate, ['ui', 'backend'])
}

function hasStructureMarkers(candidate: string, markers: string[]) {
  return markers.some(marker => fs.existsSync(path.join(candidate, marker)))
}

function findProjectRoot(startPath: string) {
  let current = path.resolve(startPath)
  for (let i = 0; i < 6; i += 1) {
    if (looksLikeProjectRoot(current)) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return path.resolve(startPath, '..')
}

function getProjectRoot() {
  return app.isPackaged
    ? path.dirname(process.resourcesPath)
    : findProjectRoot(process.env.APP_ROOT || path.join(__dirname, '..'))
}

function resolveFirstExistingPath(candidates: string[]) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate
    }
  }
  return candidates[0]
}

function getStorageRoot(projectRoot = getProjectRoot()) {
  const storageRoot = path.join(projectRoot, 'storage')
  return fs.existsSync(storageRoot) ? storageRoot : projectRoot
}

function getLogsDir(projectRoot = getProjectRoot()) {
  return path.join(getStorageRoot(projectRoot), 'logs')
}

function getBackendLogPath(projectRoot = getProjectRoot()) {
  return path.join(getLogsDir(projectRoot), 'backend_debug.log')
}

function getCacheRoot(projectRoot = getProjectRoot()) {
  return path.join(getStorageRoot(projectRoot), 'cache')
}

function getOutputRoot(projectRoot = getProjectRoot()) {
  return path.join(getStorageRoot(projectRoot), 'output')
}

function getPythonRoot(projectRoot = getProjectRoot()) {
  return resolveFirstExistingPath([
    path.join(projectRoot, 'runtime', 'python'),
    path.join(projectRoot, 'python')
  ])
}

function getPythonLocationHint(projectRoot = getProjectRoot()) {
  return `${path.join(projectRoot, 'runtime', 'python')} 或 ${path.join(projectRoot, 'python')}`
}

function getBackendRoot(projectRoot = getProjectRoot()) {
  return resolveFirstExistingPath([
    path.join(projectRoot, 'services', 'media_pipeline'),
    path.join(projectRoot, 'backend')
  ])
}

async function runPythonJsonScript(
  projectRoot: string,
  scriptPath: string,
  args: string[],
  options?: { timeoutMs?: number }
) {
  const pythonExe = path.join(getPythonRoot(projectRoot), 'python.exe')
  if (!fs.existsSync(pythonExe)) {
    return {
      success: false,
      status: 'missing_python',
      error: `找不到 Python 解释器。请确认运行时目录存在于 ${getPythonLocationHint(projectRoot)}`
    }
  }

  if (!fs.existsSync(scriptPath)) {
    return {
      success: false,
      error: `脚本不存在: ${scriptPath}`
    }
  }

  return await new Promise<Record<string, unknown>>((resolve) => {
    const processHandle = spawn(pythonExe, [scriptPath, ...args], {
      env: getPythonProcessEnv()
    })

    let output = ''
    let errorOutput = ''
    let settled = false
    const timeoutMs = options?.timeoutMs ?? 0
    const timeoutHandle = timeoutMs > 0
      ? setTimeout(() => {
        if (settled) return
        void terminateProcessTree(processHandle).finally(() => {
          if (settled) return
          settled = true
          resolve({
            success: false,
            error: `脚本执行超时 (${timeoutMs}ms)`,
            detail: errorOutput.trim() || output.trim()
          })
        })
      }, timeoutMs)
      : null

    const finalize = (payload: Record<string, unknown>) => {
      if (settled) return
      settled = true
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
      resolve(payload)
    }

    processHandle.stdout.on('data', (data) => {
      output += normalizeKnownProcessMessage(decodeProcessChunk(data))
    })

    processHandle.stderr.on('data', (data) => {
      const text = normalizeKnownProcessMessage(decodeProcessChunk(data))
      errorOutput += text
    })

    processHandle.on('close', (code) => {
      try {
        const jsonStart = output.indexOf('{')
        const jsonEnd = output.lastIndexOf('}')
        if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
          finalize({
            success: false,
            error: code === 0
              ? '脚本未返回 JSON 结果'
              : `脚本执行失败 (code=${code})`,
            detail: errorOutput.trim() || output.trim()
          })
          return
        }

        const payload = JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>
        const failedChecks = Array.isArray(payload.failed_checks) ? payload.failed_checks.length : 0
        const failedProbes = Array.isArray(payload.failed_probes) ? payload.failed_probes.length : 0
        finalize({
          success: code === 0 && failedChecks === 0 && failedProbes === 0,
          ...payload
        })
      } catch (error) {
        finalize({
          success: false,
          error: `JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`,
          detail: output.trim() || errorOutput.trim()
        })
      }
    })

    processHandle.on('error', (error) => {
      finalize({
        success: false,
        error: error.message
      })
    })
  })
}

function ensureElectronStoragePaths() {
  const projectRoot = getProjectRoot()
  const electronDataDir = path.join(getCacheRoot(projectRoot), 'electron')
  const userDataDir = path.join(electronDataDir, 'user-data')
  const cacheDir = path.join(electronDataDir, 'cache')
  const gpuCacheDir = path.join(cacheDir, 'GPUCache')

  for (const dir of [electronDataDir, userDataDir, cacheDir, gpuCacheDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  app.setPath('userData', userDataDir)
  app.setPath('sessionData', cacheDir)
  app.setPath('cache', cacheDir)
  app.commandLine.appendSwitch('disk-cache-dir', cacheDir)
  app.commandLine.appendSwitch('user-data-dir', userDataDir)
}

function getDefaultOutputDir() {
  return getOutputRoot()
}

ensureElectronStoragePaths()

function getAppPaths() {
  const projectRoot = getProjectRoot()
  return {
    projectRoot,
    outputDir: getDefaultOutputDir(),
    cacheDir: getCacheRoot(projectRoot),
    logsDir: getLogsDir(projectRoot),
    backendLogPath: getBackendLogPath(projectRoot)
  }
}

function getBackendLogSnapshot(projectRoot = getProjectRoot()) {
  const logPath = getBackendLogPath(projectRoot)
  if (!fs.existsSync(logPath)) {
    return {
      success: true,
      path: logPath,
      exists: false,
      size: 0,
      updatedAt: null,
      content: ''
    }
  }

  const stats = fs.statSync(logPath)
  const content = fs.readFileSync(logPath, 'utf-8')
  return {
    success: true,
    path: logPath,
    exists: true,
    size: stats.size,
    updatedAt: stats.mtime.toISOString(),
    content
  }
}

let activeAsrDiagnosticsPromise: Promise<Record<string, unknown>> | null = null

function isResumeAudioSegmentFile(fileName: string) {
  return /^segment(?:_retry)?_\d+\.wav$/i.test(fileName)
}

async function cleanupSessionCacheArtifacts(
  sessionCacheDir: string,
  mode: 'success' | 'failed' | 'interrupted'
) {
  if (!sessionCacheDir) {
    return { success: false, removed: false, preservedResumeFiles: 0 }
  }

  if (mode === 'success') {
    await fs.promises.rm(sessionCacheDir, { recursive: true, force: true })
    return { success: true, removed: true, preservedResumeFiles: 0 }
  }

  const audioDir = path.join(sessionCacheDir, 'audio')
  const tempDir = path.join(sessionCacheDir, 'temp')

  await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)

  let preservedResumeFiles = 0
  const audioEntries = await fs.promises.readdir(audioDir, { withFileTypes: true }).catch(() => [])

  for (const entry of audioEntries) {
    const entryPath = path.join(audioDir, entry.name)

    if (entry.isDirectory()) {
      await fs.promises.rm(entryPath, { recursive: true, force: true }).catch(() => undefined)
      continue
    }

    if (entry.isFile() && isResumeAudioSegmentFile(entry.name)) {
      preservedResumeFiles += 1
      continue
    }

    await fs.promises.rm(entryPath, { recursive: true, force: true }).catch(() => undefined)
  }

  if (preservedResumeFiles === 0) {
    await fs.promises.rm(sessionCacheDir, { recursive: true, force: true }).catch(() => undefined)
    return { success: true, removed: true, preservedResumeFiles: 0 }
  }

  return { success: true, removed: false, preservedResumeFiles }
}

function parseBackendWorkerResult(line: string) {
  const trimmed = line.trim()
  if (!trimmed.startsWith(BACKEND_WORKER_RESULT_PREFIX)) return null

  try {
    return JSON.parse(trimmed.slice(BACKEND_WORKER_RESULT_PREFIX.length))
  } catch (error) {
    logMainError('解析后端工作结果失败', {
      domain: 'backend.protocol',
      action: 'parseBackendWorkerResult',
      detail: `${trimmed}\n${error instanceof Error ? error.message : String(error)}`
    })
    return null
  }
}

interface BackendWorkerResultPayload {
  error?: string
  error_info?: {
    code?: string
    message?: string
    [key: string]: unknown
  }
}

function createBackendRequestError(workerResult: BackendWorkerResultPayload) {
  const message = workerResult?.error || workerResult?.error_info?.message || 'Backend worker request failed'
  const error = new Error(message) as Error & {
    code?: string
    error?: string
    error_info?: BackendWorkerResultPayload['error_info']
  }

  if (typeof workerResult?.error_info?.code === 'string') {
    error.code = workerResult.error_info.code
  }
  if (typeof workerResult?.error === 'string') {
    error.error = workerResult.error
  }
  if (workerResult?.error_info && typeof workerResult.error_info === 'object') {
    error.error_info = workerResult.error_info
  }

  return error
}

function createBackendProcessLineHandler(lane: BackendLane, source: 'stdout' | 'stderr') {
  return (line: string) => {
    const workerState = getBackendWorkerState(lane)
    const normalizedLine = normalizeKnownProcessMessage(line)
    if (!normalizedLine) return

    if (isFatalCudaWorkerMessage(normalizedLine)) {
      restartBackendWorkerAfterFatalCuda(lane, normalizedLine)
    }

    const workerResult = source === 'stdout' ? parseBackendWorkerResult(normalizedLine) : null
    if (workerResult) {
      if (workerState.activeRequest && workerResult.id === workerState.activeRequest.requestId) {
        const currentRequest = workerState.activeRequest
        workerState.activeRequest = null
        workerState.activeCancellation = null

        if (currentRequest.cancellationState.requested) {
          currentRequest.resolve({ success: false, canceled: true, error: 'Task canceled by user' })
          return
        }

        if (workerResult.success) {
          currentRequest.resolve(workerResult.result)
        } else {
          currentRequest.reject(createBackendRequestError(workerResult))
        }
      }
      return
    }

    const structuredEvent = parseBackendStructuredEvent(normalizedLine)
    if (structuredEvent) {
      if (workerState.activeRequest) {
        dispatchBackendStructuredEvent(workerState.activeRequest.sender, structuredEvent)
      }
      return
    }

    const structuredLogLine = parseBackendStructuredLogLine(normalizedLine)
    if (structuredLogLine) {
      const normalizedLevel = structuredLogLine.level === 'warning'
        ? 'warn'
        : structuredLogLine.level === 'debug'
          ? 'info'
          : structuredLogLine.level === 'error'
            ? 'error'
            : 'info'
      const logType = ['business', 'error', 'security', 'debug'].includes(String(structuredLogLine.log_type))
        ? structuredLogLine.log_type as 'business' | 'error' | 'security' | 'debug'
        : undefined
      const shouldSend = BACKEND_VERBOSE_STREAMS
        || logType === 'error'
        || logType === 'security'
        || normalizedLevel !== 'info'
        || logType === 'business'

      if (shouldSend && workerState.activeRequest) {
        dispatchBackendLogLine(workerState.activeRequest.sender, {
          lane,
          source,
          level: normalizedLevel,
          logType,
          domain: structuredLogLine.domain,
          traceId: structuredLogLine.trace_id,
          requestId: structuredLogLine.request_id,
          action: structuredLogLine.action,
          event: structuredLogLine.event,
          stage: structuredLogLine.stage,
          code: structuredLogLine.code,
          retryable: structuredLogLine.retryable,
          detail: structuredLogLine.detail,
          text: structuredLogLine.message || normalizedLine,
          timestamp: Date.now()
        })
      }

      if (logType === 'error' || normalizedLevel === 'error') {
        logMainError('后端输出错误日志', {
          domain: 'backend.stream',
          action: 'createBackendProcessLineHandler',
          stage: source,
          detail: `[${lane}] ${structuredLogLine.message || normalizedLine}`
        })
      } else if (BACKEND_VERBOSE_STREAMS && logType !== 'debug') {
        logMainDebug('后端输出关键日志', {
          domain: 'backend.stream',
          action: 'createBackendProcessLineHandler',
          stage: source,
          detail: `[${lane}] ${structuredLogLine.message || normalizedLine}`
        })
      }
      return
    }

    if (workerState.activeRequest) {
      if (source === 'stdout') {
        workerState.activeRequest.outputData = appendCappedText(workerState.activeRequest.outputData, normalizedLine)
      } else {
        workerState.activeRequest.errorData = appendCappedText(workerState.activeRequest.errorData, normalizedLine)
      }
    }

    if (source === 'stdout') {
      if (workerState.activeRequest) {
        const progressMatch = normalizedLine.match(/\[PROGRESS\]\s*(\d+)/)
        if (progressMatch) {
          const p = parseInt(progressMatch[1], 10)
          workerState.activeRequest.sender.send('backend-progress', { percent: p, message: `当前进度 ${p}%` })
        }

        const partialMatch = normalizedLine.match(/\[PARTIAL\]\s*(.*)/)
        if (partialMatch) {
          try {
            const pData = JSON.parse(partialMatch[1].trim())
            workerState.activeRequest.sender.send('backend-partial-result', pData)
          } catch (e) {
            logMainError('解析部分结果失败', {
              domain: 'backend.protocol',
              action: 'createBackendProcessLineHandler',
              detail: e instanceof Error ? e.message : String(e)
            })
          }
        }

        // Dependency lifecycle now relies on structured backend events.
        // Keep mirroring raw stdout lines for diagnostics, but do not forward
        // duplicate deps state events from both channels.
      }

      if (shouldMirrorBackendLine('stdout', normalizedLine)) {
        if (workerState.activeRequest) {
          dispatchBackendLogLine(workerState.activeRequest.sender, {
            lane,
            source: 'stdout',
            level: inferMirroredBackendLineLevel('stdout', normalizedLine),
            text: normalizedLine,
            timestamp: Date.now()
          })
        }
        logMainDebug('镜像后端标准输出', {
          domain: 'backend.stream',
          action: 'mirrorStdout',
          detail: `[${lane}] ${normalizedLine}`
        })
      }
      return
    }

    if (shouldMirrorBackendLine('stderr', normalizedLine)) {
      const mirroredLevel = inferMirroredBackendLineLevel('stderr', normalizedLine)
      if (workerState.activeRequest) {
        dispatchBackendLogLine(workerState.activeRequest.sender, {
          lane,
          source: 'stderr',
          level: mirroredLevel,
          text: normalizedLine,
          timestamp: Date.now()
        })
      }
      if (mirroredLevel === 'error') {
        logMainError('镜像后端标准错误输出', {
          domain: 'backend.stream',
          action: 'mirrorStderr',
          detail: `[${lane}] ${normalizedLine}`
        })
      } else if (mirroredLevel === 'warn') {
        logMainWarn('镜像后端标准错误输出告警', {
          domain: 'backend.stream',
          action: 'mirrorStderr',
          detail: `[${lane}] ${normalizedLine}`
        })
      } else {
        logMainDebug('镜像后端标准错误输出', {
          domain: 'backend.stream',
          action: 'mirrorStderr',
          detail: `[${lane}] ${normalizedLine}`
        })
      }
    }
  }
}

const processBackendStdoutLine = {
  default: createBackendProcessLineHandler('default', 'stdout'),
  prep: createBackendProcessLineHandler('prep', 'stdout')
}
const processBackendStderrLine = {
  default: createBackendProcessLineHandler('default', 'stderr'),
  prep: createBackendProcessLineHandler('prep', 'stderr')
}

function consumeBackendProcessChunk(lane: BackendLane, chunk: ProcessChunk, source: 'stdout' | 'stderr') {
  const workerState = getBackendWorkerState(lane)
  const normalized = normalizeKnownProcessMessage(decodeProcessChunk(chunk))
  let buffer = source === 'stdout' ? workerState.stdoutBuffer : workerState.stderrBuffer
  buffer += normalized
  const parts = buffer.split(/\r?\n/)
  buffer = parts.pop() || ''

  for (const line of parts) {
    if (source === 'stdout') processBackendStdoutLine[lane](line)
    else processBackendStderrLine[lane](line)
  }

  if (source === 'stdout') workerState.stdoutBuffer = buffer
  else workerState.stderrBuffer = buffer
}

function getBackendLaunchConfig() {
  const { projectRoot } = getAppPaths()
  const pythonExe = path.join(getPythonRoot(projectRoot), 'python.exe')
  const scriptPath = path.join(getBackendRoot(projectRoot), 'main.py')
  const modelsDir = path.join(projectRoot, 'models', 'index-tts', 'hub')
  const finalPythonExe = (app.isPackaged || fs.existsSync(pythonExe)) ? pythonExe : 'python'

  return {
    projectRoot,
    scriptPath,
    modelsDir,
    finalPythonExe
  }
}

async function ensureBackendWorker(lane: BackendLane) {
  const workerState = getBackendWorkerState(lane)
  if (workerState.process && workerState.process.exitCode === null && !workerState.process.killed) {
    return workerState.process as ChildProcess
  }

  const { scriptPath, modelsDir, finalPythonExe } = getBackendLaunchConfig()
  logMainBusiness('启动持久化后端工作进程', {
    domain: 'backend.worker',
    action: 'ensureBackendWorker',
    detail: `[${lane}] python=${finalPythonExe} script=${scriptPath}`
  })

  if (finalPythonExe !== 'python' && !fs.existsSync(finalPythonExe)) {
    throw new Error(`Python environment not found at ${finalPythonExe}`)
  }

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Backend script not found at ${scriptPath}`)
  }

  workerState.stdoutBuffer = ''
  workerState.stderrBuffer = ''

  const workerEnv = {
    ...getPythonProcessEnv(),
    ...workerState.launchEnvOverrides
  }
  if (Object.keys(workerState.launchEnvOverrides).length > 0) {
    logMainSecurity('后端工作进程启用了安全降级环境变量', {
      domain: 'backend.worker',
      action: 'ensureBackendWorker',
      detail: `[${lane}] ${JSON.stringify(workerState.launchEnvOverrides)}`
    })
  }

  const backendProcess = spawn(finalPythonExe, [scriptPath, '--worker', '--model_dir', modelsDir], {
    env: workerEnv
  })

  workerState.process = backendProcess

  backendProcess.stdout.on('data', (data: ProcessChunk) => {
    consumeBackendProcessChunk(lane, data, 'stdout')
  })

  backendProcess.stderr.on('data', (data: ProcessChunk) => {
    consumeBackendProcessChunk(lane, data, 'stderr')
  })

  backendProcess.on('close', (code: number) => {
    const isCurrentWorker = workerState.process === backendProcess
    if (workerState.stdoutBuffer.trim()) processBackendStdoutLine[lane](workerState.stdoutBuffer)
    if (workerState.stderrBuffer.trim()) processBackendStderrLine[lane](workerState.stderrBuffer)
    workerState.stdoutBuffer = ''
    workerState.stderrBuffer = ''
    if (isCurrentWorker) {
      workerState.process = null
    }

    if (isCurrentWorker && workerState.activeRequest) {
      const currentRequest = workerState.activeRequest
      workerState.activeRequest = null
      workerState.activeCancellation = null

      if (currentRequest.cancellationState.requested) {
        currentRequest.resolve({ success: false, canceled: true, error: 'Task canceled by user' })
      } else {
        currentRequest.reject(new Error(`Python worker exited with code ${code}. Error: ${summarizeBackendError(currentRequest.errorData)}`))
      }
    }
  })

  backendProcess.on('error', (error: Error) => {
    const isCurrentWorker = workerState.process === backendProcess
    if (isCurrentWorker) {
      workerState.process = null
    }

    if (isCurrentWorker && workerState.activeRequest) {
      const currentRequest = workerState.activeRequest
      workerState.activeRequest = null
      workerState.activeCancellation = null

      if (currentRequest.cancellationState.requested) {
        currentRequest.resolve({ success: false, canceled: true, error: 'Task canceled by user' })
      } else {
        currentRequest.reject(error)
      }
    }
  })

  return backendProcess
}

function getFfprobePath() {
  const { projectRoot } = getAppPaths()
  const bundled = path.join(projectRoot, 'resources', 'media_tools', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  return fs.existsSync(bundled) ? bundled : 'ffprobe'
}

interface FfprobeStreamInfo {
  codec_type?: string
  codec_name?: string
  width?: number | string
  height?: number | string
}

interface AnalyzeVideoResult {
  success: boolean
  info: {
    format_name: string
    duration: number
    video_codec: string
    audio_codec: string
    width: number
    height: number
  }
}

function analyzeVideoWithFfprobe(filePath: string): Promise<AnalyzeVideoResult> {
  return new Promise((resolve, reject) => {
    const ffprobePath = getFfprobePath()
    execFile(
      ffprobePath,
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 8 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || 'ffprobe failed').trim()))
          return
        }

        try {
          const parsed = JSON.parse(stdout || '{}')
          const format = parsed?.format || {}
          const streams = Array.isArray(parsed?.streams) ? parsed.streams : []
          const videoStream = (streams.find((stream: FfprobeStreamInfo) => stream?.codec_type === 'video') || {}) as FfprobeStreamInfo
          const audioStream = (streams.find((stream: FfprobeStreamInfo) => stream?.codec_type === 'audio') || {}) as FfprobeStreamInfo

          resolve({
            success: true,
            info: {
              format_name: format?.format_name || '',
              duration: Number(format?.duration) || 0,
              video_codec: videoStream?.codec_name || '',
              audio_codec: audioStream?.codec_name || '',
              width: Number(videoStream?.width) || 0,
              height: Number(videoStream?.height) || 0
            }
          })
        } catch (parseError: unknown) {
          reject(new Error(`Failed to parse ffprobe output: ${parseError instanceof Error ? parseError.message : String(parseError)}`))
        }
      }
    )
  })
}

async function cleanupExpiredCacheSessions() {
  const { cacheDir } = getAppPaths()
  const cleanupRoots = [
    path.join(cacheDir, 'sessions'),
    path.join(cacheDir, 'sources'),
    path.join(cacheDir, 'previews')
  ]

  async function removeExpiredEntries(rootPath: string, removeDirectoriesOnly: boolean) {
    await fs.promises.mkdir(rootPath, { recursive: true })
    const now = Date.now()
    const entries = await fs.promises.readdir(rootPath, { withFileTypes: true })

    for (const entry of entries) {
      if (removeDirectoriesOnly && !entry.isDirectory()) continue
      if (!removeDirectoriesOnly && !entry.isFile()) continue

      const entryPath = path.join(rootPath, entry.name)
      try {
        const stat = await fs.promises.stat(entryPath)
        const lastTouched = Math.max(
          stat.atimeMs || 0,
          stat.mtimeMs || 0,
          stat.birthtimeMs || 0
        )

        if (now - lastTouched > CACHE_RETENTION_MS) {
          await fs.promises.rm(entryPath, { recursive: true, force: true })
          logMainDebug('清理过期缓存项', {
            domain: 'cache.lifecycle',
            action: 'cleanupExpiredCacheSessions',
            detail: entryPath
          })
        }
      } catch (error) {
        logMainError('检查缓存项失败', {
          domain: 'cache.lifecycle',
          action: 'cleanupExpiredCacheSessions',
          detail: `${entryPath}\n${error instanceof Error ? error.message : String(error)}`
        })
      }
    }
  }

  try {
    const sessionsRoot = cleanupRoots[0]
    const sessionTypeDirs = await fs.promises.readdir(sessionsRoot, { withFileTypes: true }).catch(async () => {
      await fs.promises.mkdir(sessionsRoot, { recursive: true })
      return []
    })

    for (const typeDir of sessionTypeDirs) {
      if (!typeDir.isDirectory()) continue

      const typeDirPath = path.join(sessionsRoot, typeDir.name)
      await removeExpiredEntries(typeDirPath, true)
    }

    await removeExpiredEntries(cleanupRoots[1], false)
    await removeExpiredEntries(cleanupRoots[2], false)
  } catch (error) {
    logMainError('启动阶段缓存清理失败', {
      domain: 'cache.lifecycle',
      action: 'cleanupExpiredCacheSessions',
      detail: error instanceof Error ? error.message : String(error)
    })
  }
}

function isBenignTaskkillMessage(message: string) {
  const text = message.toLowerCase()
  return (
    text.includes('not found') ||
    text.includes('no running instance') ||
    text.includes('not running') ||
    text.includes('没有运行的任务') ||
    text.includes('没有找到进程')
  )
}

function terminateProcessTree(proc: ChildProcess | null): Promise<boolean> {
  if (!proc || !proc.pid) {
    return Promise.resolve(true)
  }

  if (proc.exitCode !== null || proc.killed) {
    return Promise.resolve(true)
  }

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, (error, stdout, stderr) => {
        const combinedOutput = `${stdout || ''}\n${stderr || ''}`.trim()

        if (error && !isBenignTaskkillMessage(combinedOutput)) {
          logMainError('终止后端进程失败', {
            domain: 'process.control',
            action: 'terminateProcessTree',
            detail: `pid=${proc.pid} ${combinedOutput || error.message}`
          })
          resolve(false)
          return
        }

        resolve(true)
      })
    })
  }

  return new Promise((resolve) => {
    try {
      proc.kill('SIGKILL')
      resolve(true)
    } catch (error) {
      logMainError('强制结束后端进程失败', {
        domain: 'process.control',
        action: 'terminateProcessTree',
        detail: error instanceof Error ? error.message : String(error)
      })
      resolve(false)
    }
  })
}


  function createWindow() {
    logMainBusiness('创建主窗口', { domain: 'window.lifecycle', action: 'createWindow' })
    const display = screen.getPrimaryDisplay()
    const workArea = display.workArea
    const baseMinWidth = 1480
    const baseMinHeight = 920
    const defaultWidth = Math.min(Math.max(1760, baseMinWidth), Math.max(workArea.width, baseMinWidth))
    const defaultHeight = Math.min(Math.max(1040, baseMinHeight), Math.max(workArea.height, baseMinHeight))
    const minWidth = defaultWidth
    const minHeight = defaultHeight

  win = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    minWidth,
    minHeight,
    frame: false,
    backgroundColor: '#0b1220',
    icon: path.join(process.env.VITE_PUBLIC, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      webSecurity: false // Allow loading local resources (file://)
    },
    autoHideMenuBar: true, // Hide the default menu bar (File, Edit, etc.)
  })
  logMainBusiness('主窗口创建完成', {
    domain: 'window.lifecycle',
    action: 'createWindow',
    detail: `windowId=${win.id}`
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

ipcMain.handle('window-minimize', () => {
  win?.minimize()
  return true
})

ipcMain.handle('window-maximize-toggle', () => {
  if (!win) return false
  if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }
  return true
})

ipcMain.handle('window-close', () => {
  win?.close()
  return true
})

ipcMain.handle('window-is-maximized', () => {
  return win?.isMaximized() || false
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

// Check if VC++ Runtime is installed by looking for common DLLs
async function checkVCRuntimeInstalled(): Promise<boolean> {
  // Check for vcruntime140.dll in System32
  const systemRoot = process.env.SYSTEMROOT || 'C:\\Windows';
  const dllPath = path.join(systemRoot, 'System32', 'vcruntime140.dll');
  return fs.existsSync(dllPath);
}

// Install VC++ Runtime from bundled installer
async function installVCRuntime(projectRoot: string): Promise<boolean> {
  const vcRedistPath = path.join(projectRoot, 'VC_redist.x64.exe');

  if (!fs.existsSync(vcRedistPath)) {
    logMainWarn('未找到 VC++ 运行时安装包，跳过自动安装', {
      domain: 'runtime.dependency',
      action: 'installVCRuntime',
      detail: vcRedistPath
    })
    return false;
  }

  logMainBusiness('开始安装 VC++ 运行时', {
    domain: 'runtime.dependency',
    action: 'installVCRuntime'
  })

  return new Promise((resolve) => {
    const installProcess = spawn(vcRedistPath, ['/install', '/quiet', '/norestart'], {
      stdio: 'ignore'
    });

    installProcess.on('close', (code) => {
      if (code === 0 || code === 3010) { // 3010 = success, reboot required
        logMainBusiness('VC++ 运行时安装成功', {
          domain: 'runtime.dependency',
          action: 'installVCRuntime',
          detail: `code=${code}`
        })
        resolve(true);
      } else {
        logMainError('VC++ 运行时安装失败', {
          domain: 'runtime.dependency',
          action: 'installVCRuntime',
          detail: `code=${code}`
        })
        resolve(false);
      }
    });

    installProcess.on('error', (err) => {
      logMainError('VC++ 运行时安装发生异常', {
        domain: 'runtime.dependency',
        action: 'installVCRuntime',
        detail: err instanceof Error ? err.message : String(err)
      })
      resolve(false);
    });
  });
}

// Check and install VC++ Runtime if needed
async function checkAndInstallVCRuntime(): Promise<void> {
  const isInstalled = await checkVCRuntimeInstalled();

  if (isInstalled) {
    logMainDebug('VC++ 运行时已存在', {
      domain: 'runtime.dependency',
      action: 'checkAndInstallVCRuntime'
    })
    return;
  }

  logMainBusiness('未检测到 VC++ 运行时，尝试自动安装', {
    domain: 'runtime.dependency',
    action: 'checkAndInstallVCRuntime'
  })

  // Determine project root
  const projectRoot = app.isPackaged
    ? path.dirname(process.resourcesPath)
    : path.resolve(__dirname, '..', '..');

  const success = await installVCRuntime(projectRoot);

  if (!success) {
    // Show a dialog to inform the user
    const { dialog: earlyDialog } = require('electron');
    earlyDialog.showMessageBoxSync({
      type: 'warning',
      title: '运行时组件缺失',
      message: 'Microsoft Visual C++ 运行时库安装失败。\n\n如果程序无法正常运行，请手动运行程序目录下的 VC_redist.x64.exe 进行安装。',
      buttons: ['确定']
    });
  }
}

app.whenReady().then(async () => {
  logMainBusiness('应用初始化完成，开始准备依赖与窗口', {
    domain: 'bootstrap',
    action: 'whenReady'
  })

  // Check and install VC++ Runtime before creating window
  await checkAndInstallVCRuntime();
  await cleanupExpiredCacheSessions();

  createWindow()


  // IPC Handler for converting path to file URL (robust encoding)
  ipcMain.handle('get-file-url', async (_event, filePath: string) => {
    return pathToFileURL(filePath).href
  })

  // IPC Handler for saving files (used for temp json)
  ipcMain.handle('save-file', async (_event, filePath: string, content: string) => {
    void _event
    return new Promise((resolve, reject) => {
      fs.writeFile(filePath, content, 'utf-8', (err: FileSystemError) => {
        if (err) reject(err)
        else resolve(true)
      })
    })
  })

  ipcMain.handle('read-file', async (_event, filePath: string) => {
    void _event
    return new Promise((resolve, reject) => {
      fs.readFile(filePath, 'utf-8', (err: FileSystemError, content: string) => {
        if (err) reject(err)
        else resolve(content)
      })
    })
  })

  // IPC Handler for file dialog
  ipcMain.handle('dialog:openFile', async (_event, options) => {
    if (!win) return { canceled: true, filePaths: [] }
    return await dialog.showOpenDialog(win, options)
  })

  ipcMain.handle('dialog:showSaveDialog', async (_event, options) => {
    if (!win) return { canceled: true, filePath: undefined }
    return await dialog.showSaveDialog(win, options)
  })

  // IPC Handler for directory creation
  ipcMain.handle('ensure-dir', async (_event, dirPath: string) => {
    void _event
    return new Promise((resolve, reject) => {
      fs.mkdir(dirPath, { recursive: true }, (err: FileSystemError) => {
        if (err) reject(err)
        else resolve(true)
      })
    })
  })

  ipcMain.handle('delete-path', async (_event, targetPath: string) => {
    void _event
    try {
      await fs.promises.rm(targetPath, { recursive: true, force: true })
      return true
    } catch (error) {
      logMainError('删除路径失败', {
        domain: 'filesystem',
        action: 'delete-path',
        detail: `${targetPath}\n${error instanceof Error ? error.message : String(error)}`
      })
      return false
    }
  })

  ipcMain.handle(
    'cleanup-session-cache',
    async (_event, payload: { sessionCacheDir: string; mode: 'success' | 'failed' | 'interrupted' }) => {
      void _event
      try {
        return await cleanupSessionCacheArtifacts(payload?.sessionCacheDir, payload?.mode || 'failed')
      } catch (error) {
        logMainError('清理会话缓存失败', {
          domain: 'cache.lifecycle',
          action: 'cleanup-session-cache',
          detail: `${payload?.sessionCacheDir || ''}\n${error instanceof Error ? error.message : String(error)}`
        })
        return { success: false, removed: false, preservedResumeFiles: 0 }
      }
    }
  )

  // IPC Handler to get paths
  ipcMain.handle('get-paths', async () => {
    return getAppPaths();
  })

  ipcMain.handle('analyze-video-metadata', async (_event, filePath: string) => {
    return analyzeVideoWithFfprobe(filePath)
  })

  // IPC Handler for Python Backend
  ipcMain.handle('run-backend', async (_event, payload: string[] | { args?: string[]; lane?: BackendLane }) => {
    void _event
    const requestArgs = Array.isArray(payload) ? payload : payload?.args
    const lane = (Array.isArray(payload) ? 'default' : payload?.lane) === 'prep' ? 'prep' : 'default'
    if (!Array.isArray(requestArgs)) {
      throw new Error('run-backend payload must provide an args array')
    }

    return enqueueBackendRun(lane, async () => {
      logMainDebug('派发后端任务', {
        domain: 'backend.request',
        action: 'run-backend',
        detail: `[${lane}] ${JSON.stringify(requestArgs)}`
      })
      const backendProcess = await ensureBackendWorker(lane)
      const workerState = getBackendWorkerState(lane)
      const requestId = `req-${Date.now()}-${++workerState.requestCounter}`
      const cancellationState = { requested: false }

      return await new Promise((resolve, reject) => {
        workerState.activeRequest = {
          requestId,
          sender: _event.sender,
          resolve,
          reject,
          cancellationState,
          outputData: '',
          errorData: ''
        }
        workerState.activeCancellation = cancellationState

        if (!backendProcess.stdin || backendProcess.stdin.destroyed || !backendProcess.stdin.writable) {
          workerState.activeRequest = null
          workerState.activeCancellation = null
          reject(new Error('Backend worker stdin is not writable'))
          return
        }

        backendProcess.stdin.write(`${JSON.stringify({ id: requestId, args: requestArgs })}\n`, 'utf8')
      })
    })
  })

  ipcMain.handle('cache-video', async (_event, filePath: string) => {
    try {
      // Determine .cache folder path
      const { cacheDir } = getAppPaths()
      const sourceCacheDir = path.join(cacheDir, 'sources')

      // Ensure .cache exists
      if (!fs.existsSync(sourceCacheDir)) {
        fs.mkdirSync(sourceCacheDir, { recursive: true });
      }

      // 1. If input file is already in .cache, assume it's cached and return as is.
      // Normalize paths for comparison
      const normalizedInput = path.normalize(filePath);
      const normalizedCache = path.normalize(cacheDir);

      if (normalizedInput.startsWith(normalizedCache)) {
        return normalizedInput;
      }

      // 2. Compute stable filename based on input path hash
      // This ensures same file path maps to same cached file
      const crypto = require('node:crypto');
      const hash = crypto.createHash('md5').update(normalizedInput).digest('hex');
      const basename = path.basename(filePath);
      // Limit filename length just in case
      const safeBasename = `${hash.substring(0, 12)}_${basename}`;
      const destPath = path.join(sourceCacheDir, safeBasename);

      // 3. Check if we already have it
      if (fs.existsSync(destPath)) {
        logMainDebug('复用已缓存源文件', {
          domain: 'cache.source',
          action: 'cache-video',
          detail: filePath
        })
        return destPath;
      }

      // 4. Copy if new
      logMainBusiness('写入新的源文件缓存', {
        domain: 'cache.source',
        action: 'cache-video',
        detail: `${filePath} -> ${destPath}`
      })
      await fs.promises.copyFile(filePath, destPath);

      return destPath;
    } catch (error) {
      logMainError('源文件缓存失败', {
        domain: 'cache.source',
        action: 'cache-video',
        detail: error instanceof Error ? error.message : String(error)
      })
      throw error;
    }
  })

  // IPC Handler to open folder
  ipcMain.handle('open-folder', async (_event, filePath: string) => {
    try {
      // if filePath is file, show item in folder. If dir, open path.
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          await shell.openPath(filePath);
        } else {
          shell.showItemInFolder(filePath);
        }
        return true;
      }
      return false;
    } catch (e) {
      logMainError('打开目录失败', {
        domain: 'filesystem',
        action: 'open-folder',
        detail: e instanceof Error ? e.message : String(e)
      })
      return false;
    }
  })

  // IPC Handler to open file externally (system default player)
  ipcMain.handle('open-external', async (_event, filePath: string) => {
    try {
      await shell.openPath(filePath);
      return true;
    } catch (e) {
      logMainError('调用系统程序打开文件失败', {
        domain: 'filesystem',
        action: 'open-external',
        detail: e instanceof Error ? e.message : String(e)
      })
      return false;
    }
  })

  // IPC Handler to kill backend
  ipcMain.handle('kill-backend', async () => {
    const processesToKill = (Object.keys(backendWorkers) as BackendLane[])
      .map((lane) => {
        const workerState = getBackendWorkerState(lane)
        const processToKill = workerState.process
        if (workerState.activeCancellation) {
          workerState.activeCancellation.requested = true
        }
        workerState.process = null
        return processToKill
      })
      .filter((proc): proc is ChildProcess => Boolean(proc))

    if (processesToKill.length === 0) {
      return true
    }

    try {
      const results = await Promise.all(processesToKill.map(async (proc) => {
        logMainSecurity('终止后端进程', {
          domain: 'process.control',
          action: 'kill-backend',
          detail: `pid=${proc.pid}`
        })
        return terminateProcessTree(proc)
      }))
      return results.every(Boolean)
    } catch (e) {
      logMainError('停止全部后端进程失败', {
        domain: 'process.control',
        action: 'kill-backend',
        detail: e instanceof Error ? e.message : String(e)
      })
      return false
    }
  })
  // IPC Handler to open backend log
  ipcMain.handle('open-backend-log', async () => {
    try {
      const projectRoot = getProjectRoot()
      const logPath = getBackendLogPath(projectRoot);

      if (!fs.existsSync(logPath)) {
        logMainWarn('未找到后端日志文件', {
          domain: 'observability',
          action: 'open-backend-log',
          detail: logPath
        })
        return { success: false, error: 'Log file not found' };
      }

      const error = await shell.openPath(logPath);
      if (error) {
        logMainError('打开后端日志失败', {
          domain: 'observability',
          action: 'open-backend-log',
          detail: error
        })
        return { success: false, error };
      }
      return { success: true };
    } catch (e) {
      logMainError('打开后端日志发生异常', {
        domain: 'observability',
        action: 'open-backend-log',
        detail: e instanceof Error ? e.message : String(e)
      })
      return { success: false, error: String(e) };
    }
  })

  ipcMain.handle('read-backend-log', async () => {
    try {
      return getBackendLogSnapshot(getProjectRoot())
    } catch (e) {
      logMainError('读取后端日志发生异常', {
        domain: 'observability',
        action: 'read-backend-log',
        detail: e instanceof Error ? e.message : String(e)
      })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('clear-backend-log', async () => {
    try {
      const projectRoot = getProjectRoot()
      const logsDir = getLogsDir(projectRoot)
      const logPath = getBackendLogPath(projectRoot)

      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true })
      }

      fs.writeFileSync(logPath, '', 'utf-8')
      return { success: true, path: logPath }
    } catch (e) {
      logMainError('清空后端日志发生异常', {
        domain: 'observability',
        action: 'clear-backend-log',
        detail: e instanceof Error ? e.message : String(e)
      })
      return { success: false, error: String(e) }
    }
  })

  // IPC Handler to repair python environment
  ipcMain.handle('fix-python-env', async (_event) => {
    void _event
    return new Promise((resolve) => {
      try {
        const projectRoot = getProjectRoot()
        const pythonExe = path.join(getPythonRoot(projectRoot), 'python.exe');
        const requirementsPath = path.join(projectRoot, 'requirements.txt');

        if (!fs.existsSync(pythonExe)) {
          resolve({ success: false, error: `找不到 Python 解释器。请确认运行时目录存在于 ${getPythonLocationHint(projectRoot)}` });
          return;
        }

        if (!fs.existsSync(requirementsPath)) {
          resolve({ success: false, error: `找不到 requirements.txt。请确认文件存在于 ${projectRoot}` });
          return;
        }

        logMainSecurity('开始修复 Python 运行环境', {
          domain: 'runtime.env',
          action: 'fix-python-env',
          detail: `python=${pythonExe}`
        })

        const installProcess = spawn(pythonExe, ['-m', 'pip', 'install', '-r', requirementsPath], {
          env: getPythonProcessEnv()
        });

        let output = '';
        let errorOut = '';

        installProcess.stdout.on('data', (data) => {
          const s = normalizeKnownProcessMessage(decodeProcessChunk(data));
          output += s;
          logMainDebug('pip 标准输出', {
            domain: 'runtime.env',
            action: 'fix-python-env',
            detail: s.trim()
          })
        });

        installProcess.stderr.on('data', (data) => {
          const s = normalizeKnownProcessMessage(decodeProcessChunk(data));
          errorOut += s;
          logMainWarn('pip 标准错误输出', {
            domain: 'runtime.env',
            action: 'fix-python-env',
            detail: s.trim()
          })
        });

        installProcess.on('close', (code) => {
          if (code === 0) {
            logMainBusiness('Python 运行环境修复完成', {
              domain: 'runtime.env',
              action: 'fix-python-env'
            })
            resolve({ success: true, output });
          } else {
            logMainError('Python 运行环境修复失败', {
              domain: 'runtime.env',
              action: 'fix-python-env',
              detail: `code=${code}`
            })
            resolve({ success: false, error: `Pip install failed (Code ${code}). \nError: ${errorOut}` });
          }
        });

        installProcess.on('error', (err) => {
          resolve({ success: false, error: `Spawn error: ${err.message}` });
        });

      } catch (e: unknown) {
        resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  })

  // IPC Handler to check python environment (list missing deps)
  ipcMain.handle('check-python-env', async (_event) => {
    void _event
    return new Promise((resolve) => {
      try {
        const projectRoot = getProjectRoot()
        const pythonExe = path.join(getPythonRoot(projectRoot), 'python.exe');
        const requirementsPath = path.join(projectRoot, 'requirements.txt');
        const checkScriptPath = path.join(getBackendRoot(projectRoot), 'check_requirements.py');

        if (!fs.existsSync(pythonExe)) {
          resolve({ success: false, status: 'missing_python', error: `找不到 Python 解释器。请确认运行时目录存在于 ${getPythonLocationHint(projectRoot)}` });
          return;
        }
        if (!fs.existsSync(requirementsPath)) {
          resolve({ success: false, error: "requirements.txt not found" });
          return;
        }
        if (!fs.existsSync(checkScriptPath)) {
          resolve({ success: false, error: "check_requirements.py not found" });
          return;
        }

        const checkProcess = spawn(pythonExe, [checkScriptPath, requirementsPath, '--json'], {
          env: getPythonProcessEnv()
        });

        let output = '';
        checkProcess.stdout.on('data', (data) => {
          output += normalizeKnownProcessMessage(decodeProcessChunk(data));
        });
        checkProcess.stderr.on('data', (data) => {
          logMainWarn('依赖检查输出告警', {
            domain: 'runtime.env',
            action: 'check-python-env',
            detail: normalizeKnownProcessMessage(decodeProcessChunk(data)).trim()
          })
        });

        checkProcess.on('close', (code) => {
          try {
            // Attempt to find JSON in output
            const jsonStart = output.indexOf('{');
            const jsonEnd = output.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1) {
              const jsonStr = output.substring(jsonStart, jsonEnd + 1);
              const result = JSON.parse(jsonStr);
              resolve({ success: true, missing: result.missing || [] });
            } else {
              // No JSON found
              if (code === 0 && !output.trim()) resolve({ success: true, missing: [] }); // Empty output usually OK if logic implies success, but our script prints success msg.
              // Actually our script prints "All good" if no JSON.
              // Ideally we look for success status or non-zero code.
              if (code !== 0) resolve({ success: false, error: "Dependency check failed (non-zero exit)" });
              else resolve({ success: true, missing: [] });
            }
          } catch (e: unknown) {
            resolve({ success: false, error: `Parse error: ${e instanceof Error ? e.message : String(e)}` });
          }
        });

        checkProcess.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });

      } catch (e: unknown) {
        resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  })

  ipcMain.handle('run-asr-diagnostics', async (_event) => {
    void _event
    try {
      if (activeAsrDiagnosticsPromise) {
        return await activeAsrDiagnosticsPromise
      }

      const projectRoot = getProjectRoot()
      const scriptPath = path.join(projectRoot, 'scripts', 'run_asr_diagnostics.py')
      activeAsrDiagnosticsPromise = runPythonJsonScript(projectRoot, scriptPath, [], { timeoutMs: 8 * 60 * 1000 })
      const result = await activeAsrDiagnosticsPromise

      if (!result.success) {
        logMainWarn('ASR 运行诊断返回失败结果', {
          domain: 'runtime.diagnostics',
          action: 'run-asr-diagnostics',
          detail: String(result.error || result.detail || 'unknown')
        })
      }

      return result
    } catch (error) {
      logMainError('执行 ASR 运行诊断失败', {
        domain: 'runtime.diagnostics',
        action: 'run-asr-diagnostics',
        detail: error instanceof Error ? error.message : String(error)
      })
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      activeAsrDiagnosticsPromise = null
    }
  })

  // Helper function to resolve Models Root
  const resolveModelsRoot = () => {
    let modelsRoot = '';
    const projectRoot = getProjectRoot()

    if (app.isPackaged) {
      if (process.env.PORTABLE_EXECUTABLE_DIR) {
        modelsRoot = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'models');
      } else {
        modelsRoot = path.join(projectRoot, 'models');
      }
    } else {
      modelsRoot = path.join(projectRoot, 'models');
    }
    return { modelsRoot, projectRoot };
  };

  // IPC Handler to check model status
  ipcMain.handle('check-model-status', async (_event) => {
    void _event
    return new Promise((resolve) => {
      try {
        const { modelsRoot, projectRoot } = resolveModelsRoot();
        const pythonRoot = getPythonRoot(projectRoot);
        logMainDebug('检查模型目录状态', {
          domain: 'model.lifecycle',
          action: 'check-model-status',
          detail: modelsRoot
        })

        const checkDir = (subpath: string[]) => {
          for (const p of subpath) {
            const fullPath = path.join(modelsRoot, p);
            if (fs.existsSync(fullPath)) return true;
          }
          return false;
        };

        const checkModelArtifacts = (subpaths: string[], requiredFiles: string[]) => {
          for (const p of subpaths) {
            const basePath = path.join(modelsRoot, p);
            if (!fs.existsSync(basePath)) continue;

            const candidateDirs = [basePath];
            try {
              for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                  candidateDirs.push(path.join(basePath, entry.name));
                }
              }
            } catch {
              // Ignore readdir failures and keep base path only.
            }

            for (const candidateDir of candidateDirs) {
              const isReady = requiredFiles.every(fileName => fs.existsSync(path.join(candidateDir, fileName)));
              if (isReady) return true;
            }
          }
          return false;
        };

        const checkPythonRuntimeArtifacts = (relativePaths: string[]) => {
          return relativePaths.every((relativePath) => fs.existsSync(path.join(pythonRoot, relativePath)));
        };

        const createStatusDetail = (
          installed: boolean,
          state: string,
          detail: string,
          repairable = false
        ) => ({
          installed,
          state,
          detail,
          repairable,
        });

        const collectCandidateDirs = (baseDir: string) => {
          const candidateDirs = [baseDir];
          try {
            for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
              if (entry.isDirectory() && !entry.name.startsWith('.')) {
                candidateDirs.push(path.join(baseDir, entry.name));
              }
            }
          } catch {
            // Ignore readdir failures and keep base path only.
          }
          return candidateDirs;
        };

        const checkFilesInDirOrChildren = (modelDir: string, requiredFiles: string[]) => {
          for (const candidateDir of collectCandidateDirs(modelDir)) {
            const isReady = requiredFiles.every((fileName) => fs.existsSync(path.join(candidateDir, fileName)));
            if (isReady) {
              return true;
            }
          }
          return false;
        };

        const checkQwenTtsTokenizerArtifacts = (modelDir: string) => {
          const textTokenizerReady = checkFilesInDirOrChildren(modelDir, ['tokenizer.json', 'tokenizer_config.json']);
          if (textTokenizerReady) {
            return true;
          }
          const audioTokenizerReady = checkFilesInDirOrChildren(modelDir, [
            'config.json',
            'model.safetensors',
            'preprocessor_config.json',
          ]);
          return audioTokenizerReady;
        };

        const checkTransformerModelArtifacts = (modelDir: string) => {
          for (const candidateDir of collectCandidateDirs(modelDir)) {
            const configReady = fs.existsSync(path.join(candidateDir, 'config.json'));
            const hasWeights = [
              'model.safetensors',
              'model.safetensors.index.json',
              'pytorch_model.bin',
              'pytorch_model.bin.index.json',
            ].some((fileName) => fs.existsSync(path.join(candidateDir, fileName)));
            if (configReady && hasWeights) {
              return true;
            }
          }
          return false;
        };

        const preferredOverlayRuntimeDir = path.join(projectRoot, 'runtime', 'overlays', 'transformers5_asr');
        const legacyOverlayRuntimeDirs = [
          path.join(projectRoot, 'storage', 'runtime', 'transformers5_asr'),
          path.join(projectRoot, 'storage', 'cache', 'transformers5_asr_overlay')
        ];
        const overlayRuntimeDir = fs.existsSync(preferredOverlayRuntimeDir)
          ? preferredOverlayRuntimeDir
          : (legacyOverlayRuntimeDirs.find((candidate) => fs.existsSync(candidate)) || preferredOverlayRuntimeDir);
        const overlayTransformersReady = fs.existsSync(path.join(overlayRuntimeDir, 'transformers'));
        const overlayVersion = (() => {
          if (!fs.existsSync(overlayRuntimeDir)) {
            return null;
          }
          try {
            const distInfo = fs.readdirSync(overlayRuntimeDir, { withFileTypes: true }).find((entry) => (
              entry.isDirectory() && /^transformers-.*\.dist-info$/i.test(entry.name)
            ));
            return distInfo ? distInfo.name.replace(/^transformers-/, '').replace(/\.dist-info$/i, '') : null;
          } catch {
            return null;
          }
        })();

        const getTransformers5AsrRuntimeDetail = () => {
          if (!fs.existsSync(overlayRuntimeDir)) {
            return createStatusDetail(
              false,
              'missing_runtime',
              `未找到共享 Transformers 5.x ASR 运行时目录：${overlayRuntimeDir}`
            );
          }

          if (!overlayTransformersReady) {
            return createStatusDetail(
              false,
              'runtime_incomplete',
              `共享 Transformers 5.x ASR 运行时目录存在，但缺少 transformers 包：${overlayRuntimeDir}`
            );
          }

          return createStatusDetail(
            true,
            'ready',
            `共享 Transformers 5.x ASR 运行时已就绪${overlayVersion ? `（overlay=${overlayVersion}）` : ''}。`
          );
        };

        const getFunAsrRuntimeDetail = () => {
          const runtimeReady = checkPythonRuntimeArtifacts([
            path.join('Lib', 'site-packages', 'funasr', '__init__.py'),
          ]);
          if (!runtimeReady) {
            return createStatusDetail(false, 'missing_runtime', '当前 Python 运行时缺少 funasr 包，无法按官方 AutoModel 链路执行识别。', true);
          }
          return createStatusDetail(true, 'ready', 'FunASR Python runtime 已就绪。');
        };

        const getFunAsrStatusDetail = () => {
          const profileRoot = path.join(modelsRoot, 'FunASR-paraformer-zh');
          const vadRoot = path.join(modelsRoot, 'FunASR-fsmn-vad');
          const puncRoot = path.join(modelsRoot, 'FunASR-ct-punc');

          const readFunAsrAsset = (
            assetRoot: string,
            label: string,
          ) => {
            if (!fs.existsSync(assetRoot)) {
              return createStatusDetail(false, 'missing', `未找到 ${label} 目录。`, true);
            }
            const entries = fs.readdirSync(assetRoot, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
            if (entries.length === 0) {
              return createStatusDetail(false, 'incomplete', `${label} 目录存在但为空。`, true);
            }
            return createStatusDetail(true, 'ready', `${label} 目录已就绪。`);
          };

          const acousticDetail = readFunAsrAsset(profileRoot, 'FunASR acoustic model');
          const vadDetail = readFunAsrAsset(vadRoot, 'FunASR VAD model');
          const puncDetail = readFunAsrAsset(puncRoot, 'FunASR punctuation model');

          const funAsrRuntimeReady = checkPythonRuntimeArtifacts([
            path.join('Lib', 'site-packages', 'funasr', '__init__.py'),
          ]);

          if (!funAsrRuntimeReady) {
            return createStatusDetail(
              acousticDetail.installed || vadDetail.installed || puncDetail.installed,
              'missing_runtime',
              'FunASR 资源目录可单独下载，但当前 Python 运行时缺少 funasr 包，识别阶段无法加载官方 AutoModel。'
            );
          }

          if (!acousticDetail.installed) {
            return acousticDetail;
          }
          if (!vadDetail.installed) {
            return vadDetail;
          }
          if (!puncDetail.installed) {
            return puncDetail;
          }

          return createStatusDetail(
            true,
            'ready',
            'FunASR acoustic / VAD / punctuation 资源与 Python runtime 均已就绪。'
          );
        };

        const getVibeVoiceAsrStatusDetail = () => {
          const modelDir = path.join(modelsRoot, 'VibeVoice-ASR-HF');
          if (!fs.existsSync(modelDir)) {
            return createStatusDetail(false, 'missing', '未找到 VibeVoice-ASR 模型目录。');
          }

          const entries = fs.readdirSync(modelDir, { withFileTypes: true });
          if (entries.length === 0) {
            return createStatusDetail(false, 'incomplete', '模型目录存在但为空，当前本地下载未完成。');
          }

          const configPath = path.join(modelDir, 'config.json');
          if (!fs.existsSync(configPath)) {
            return createStatusDetail(false, 'incomplete', '缺少 config.json，当前目录结构无法被加载器识别。');
          }

          const hasWeights = [
            path.join(modelDir, 'model.safetensors'),
            path.join(modelDir, 'model.safetensors.index.json'),
            path.join(modelDir, 'pytorch_model.bin'),
          ].some((candidate) => fs.existsSync(candidate));
          if (!hasWeights) {
            return createStatusDetail(false, 'incomplete', '缺少主权重文件，预期存在 model.safetensors、model.safetensors.index.json 或 pytorch_model.bin。');
          }

          const hasProcessorArtifacts = [
            path.join(modelDir, 'processor_config.json'),
            path.join(modelDir, 'preprocessor_config.json'),
            path.join(modelDir, 'tokenizer.json'),
            path.join(modelDir, 'tokenizer_config.json'),
            path.join(modelDir, 'feature_extractor_config.json'),
          ].some((candidate) => fs.existsSync(candidate));
          if (!hasProcessorArtifacts) {
            return createStatusDetail(false, 'incomplete', '缺少 processor/tokenizer/feature extractor 配置文件，Transformers 无法实例化处理器。');
          }

          if (!fs.existsSync(overlayRuntimeDir)) {
            return createStatusDetail(true, 'missing_runtime', `VibeVoice-ASR 需要共享 Transformers 5.x ASR 运行时，但当前目录不存在：${overlayRuntimeDir}`);
          }

          if (!overlayTransformersReady) {
            return createStatusDetail(true, 'runtime_incomplete', `共享 Transformers 5.x ASR 运行时目录存在，但缺少 transformers 包：${overlayRuntimeDir}`);
          }

          return createStatusDetail(true, 'ready', `模型文件、processor 配置与共享 Transformers 5.x ASR 运行时均已就绪${overlayVersion ? `（overlay=${overlayVersion}）` : ''}。`);
        };

        const getFasterWhisperRuntimeDetail = () => {
          const binaryCandidates = process.platform === 'win32'
            ? ['faster-whisper-xxl.exe', 'faster-whisper.exe']
            : ['faster-whisper-xxl', 'faster-whisper'];
          const binarySearchRoots = getFasterWhisperRuntimeSearchRoots(projectRoot);
          const binaryPath = findFileInRoots(binarySearchRoots, binaryCandidates);
          const hasBinary = Boolean(binaryPath);

          const installed = hasBinary;
          const state = installed ? 'ready' : 'blocked';
          let detail = 'faster-whisper runtime 未就绪。';

          detail = hasBinary
            ? `当前使用兼容二进制 runtime：${binaryPath}`
            : '当前未找到 faster-whisper CLI 组件。';

          return createStatusDetail(
            installed,
            state,
            detail,
            !installed,
          );
        };

        const getFasterWhisperModelDetail = (relativeDir: string, label: string) => {
          const modelDir = path.join(modelsRoot, relativeDir);
          if (!fs.existsSync(modelDir)) {
            return createStatusDetail(false, 'missing', `未找到 ${label} 模型目录。`, true);
          }
          if (!checkModelArtifacts([relativeDir], ['config.json', 'model.bin', 'tokenizer.json'])) {
            return createStatusDetail(false, 'incomplete', `${label} 模型目录存在，但缺少 config.json、model.bin 或 tokenizer.json。`, true);
          }
          return createStatusDetail(true, 'ready', `${label} 模型文件已就绪。`);
        };

        const getQwenAsrModelDetail = (relativeDir: string, label: string) => {
          const modelDir = path.join(modelsRoot, relativeDir);
          if (!fs.existsSync(modelDir)) {
            return createStatusDetail(false, 'missing', `未找到 ${label} 模型目录。`, true);
          }
          if (!checkTransformerModelArtifacts(modelDir)) {
            return createStatusDetail(false, 'incomplete', `${label} 模型目录存在，但缺少 config.json 或主权重文件。`, true);
          }
          return createStatusDetail(true, 'ready', `${label} 模型文件已就绪。`);
        };

        const getIndexTtsStatusDetail = () => {
          const modelDir = path.join(modelsRoot, 'index-tts');
          if (!fs.existsSync(modelDir)) {
            return createStatusDetail(false, 'missing', '未找到 Index-TTS 模型目录。', true);
          }
          const configPath = path.join(modelDir, 'config.yaml');
          if (!fs.existsSync(configPath)) {
            return createStatusDetail(false, 'incomplete', 'Index-TTS 缺少 config.yaml。', true);
          }
          const hubDir = path.join(modelDir, 'hub');
          if (!fs.existsSync(hubDir)) {
            return createStatusDetail(false, 'incomplete', 'Index-TTS 缺少 hub 目录，无法提供本地 HF 缓存。', true);
          }
          const checkpointCandidates = [
            path.join(modelDir, 'gpt.pth'),
            path.join(modelDir, 'bigvgan_generator.pt'),
            path.join(modelDir, 's2mel.pth'),
          ];
          const foundCheckpointCount = checkpointCandidates.filter((candidate) => fs.existsSync(candidate)).length;
          if (foundCheckpointCount === 0) {
            return createStatusDetail(false, 'incomplete', 'Index-TTS 根目录缺少主要 checkpoint 文件。', true);
          }
          return createStatusDetail(true, 'ready', 'Index-TTS 配置、hub 缓存与主要 checkpoint 已检测到。');
        };

        const getQwenTokenizerStatusDetail = () => {
          const candidates = [
            path.join(modelsRoot, 'Qwen3-TTS-Tokenizer-12Hz'),
            path.join(modelsRoot, 'Qwen', 'Qwen3-TTS-Tokenizer-12Hz'),
          ];
          const modelDir = candidates.find((candidate) => fs.existsSync(candidate));
          if (!modelDir) {
            return createStatusDetail(false, 'missing', '未找到 Qwen3-TTS tokenizer 目录。', true);
          }
          if (!checkQwenTtsTokenizerArtifacts(modelDir)) {
            return createStatusDetail(
              false,
              'incomplete',
              'Qwen3-TTS tokenizer 目录存在，但缺少可识别的 tokenizer 资源。当前兼容两类布局：文本 tokenizer（tokenizer.json + tokenizer_config.json）或音频 tokenizer（config.json + model.safetensors + preprocessor_config.json）。',
              true
            );
          }
          return createStatusDetail(true, 'ready', 'Qwen3-TTS tokenizer 已就绪。');
        };

        const getQwenTtsModelStatusDetail = (relativeDir: string, label: string) => {
          const directDir = path.join(modelsRoot, relativeDir);
          const nestedDir = path.join(modelsRoot, 'Qwen', relativeDir);
          const modelDir = [directDir, nestedDir].find((candidate) => fs.existsSync(candidate));
          if (!modelDir) {
            return createStatusDetail(false, 'missing', `未找到 ${label} 模型目录。`, true);
          }
          if (!checkTransformerModelArtifacts(modelDir)) {
            return createStatusDetail(false, 'incomplete', `${label} 模型目录存在，但缺少 config.json 或主权重文件。`, true);
          }
          return createStatusDetail(true, 'ready', `${label} 模型文件已就绪。`);
        };

        const getSourceSeparationStatusDetail = () => {
          const modelDir = path.join(modelsRoot, 'source_separation');
          const candidates = [
            path.join(modelDir, 'hdemucs_high_musdb_plus.pt'),
            path.join(modelDir, 'hdemucs_high_trained.pt')
          ];
          const existing = candidates.find((candidate) => fs.existsSync(candidate));
          if (!existing) {
            return createStatusDetail(false, 'blocked', '背景音保留模式缺少 HDemucs 权重文件，无法执行人声分离。', true);
          }
          return createStatusDetail(true, 'ready', `已检测到分离模型：${path.basename(existing)}`);
        };

        const getRifeStatusDetail = () => {
          const rifeRoot = path.join(modelsRoot, 'rife');
          if (!fs.existsSync(rifeRoot)) {
            return createStatusDetail(false, 'blocked', '未找到 RIFE 目录，当前无法执行光流补帧。', true);
          }

          let rifeExe = '';
          let rifeModelDir = '';
          for (const dirent of fs.readdirSync(rifeRoot, { withFileTypes: true })) {
            const nestedRoot = path.join(rifeRoot, dirent.name);
            const searchRoots = dirent.isDirectory() ? [nestedRoot] : [rifeRoot];
            for (const searchRoot of searchRoots) {
              const exeCandidate = path.join(searchRoot, process.platform === 'win32' ? 'rife-ncnn-vulkan.exe' : 'rife-ncnn-vulkan');
              const modelCandidate = path.join(searchRoot, 'rife-v4.6');
              if (!rifeExe && fs.existsSync(exeCandidate)) {
                rifeExe = exeCandidate;
              }
              if (!rifeModelDir && fs.existsSync(modelCandidate)) {
                rifeModelDir = modelCandidate;
              }
            }
          }

          if (!rifeExe) {
            return createStatusDetail(false, 'incomplete', 'RIFE 目录存在，但缺少 rife-ncnn-vulkan 可执行文件。', true);
          }

          if (!rifeModelDir) {
            return createStatusDetail(false, 'incomplete', 'RIFE 可执行文件已存在，但缺少 rife-v4.6 模型目录。', true);
          }

          return createStatusDetail(true, 'ready', 'RIFE 可执行文件与 rife-v4.6 模型目录均已就绪。');
        };

        const funAsrRuntimeDetail = getFunAsrRuntimeDetail();
        const funAsrDetail = getFunAsrStatusDetail();
        const funAsrVadDetail = fs.existsSync(path.join(modelsRoot, 'FunASR-fsmn-vad'))
          ? (() => {
              const entries = fs.readdirSync(path.join(modelsRoot, 'FunASR-fsmn-vad'), { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
              return entries.length > 0
                ? createStatusDetail(true, 'ready', 'FunASR VAD 资源目录已就绪。')
                : createStatusDetail(false, 'incomplete', 'FunASR VAD 资源目录存在但为空。', true);
            })()
          : createStatusDetail(false, 'missing', '未找到 FunASR VAD 资源目录。', true);
        const funAsrPuncDetail = fs.existsSync(path.join(modelsRoot, 'FunASR-ct-punc'))
          ? (() => {
              const entries = fs.readdirSync(path.join(modelsRoot, 'FunASR-ct-punc'), { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
              return entries.length > 0
                ? createStatusDetail(true, 'ready', 'FunASR punctuation 资源目录已就绪。')
                : createStatusDetail(false, 'incomplete', 'FunASR punctuation 资源目录存在但为空。', true);
            })()
          : createStatusDetail(false, 'missing', '未找到 FunASR punctuation 资源目录。', true);
        const vibeVoiceAsrDetail = getVibeVoiceAsrStatusDetail();
        const fasterWhisperRuntimeDetail = getFasterWhisperRuntimeDetail();
        const transformers5AsrRuntimeDetail = getTransformers5AsrRuntimeDetail();
        const fasterWhisperQualityDetail = getFasterWhisperModelDetail('faster-whisper-large-v3-ct2', 'faster-whisper large-v3');
        const fasterWhisperBalancedDetail = getFasterWhisperModelDetail('faster-whisper-large-v3-turbo-ct2', 'faster-whisper turbo');
        const qwenAsr06BDetail = getQwenAsrModelDetail('Qwen3-ASR-0.6B', 'Qwen3-ASR 0.6B');
        const qwenAsr17BDetail = getQwenAsrModelDetail('Qwen3-ASR-1.7B', 'Qwen3-ASR 1.7B');
        const getQwenAlignerStatusDetail = () => {
          const baseDetail = getQwenAsrModelDetail('Qwen3-ForcedAligner-0.6B', 'Qwen3 Forced Aligner');
          if (!baseDetail.installed) {
            return baseDetail;
          }
          const alignerRuntimeReady = checkPythonRuntimeArtifacts([
            path.join('Lib', 'site-packages', 'qwen_asr', '__init__.py'),
            path.join('Lib', 'site-packages', 'qwen_omni_utils', '__init__.py'),
          ]);
          if (!alignerRuntimeReady) {
            return createStatusDetail(
              true,
              'missing_runtime',
              'Qwen3 Forced Aligner 模型文件已就绪，但当前运行时缺少 qwen-asr / qwen-omni-utils 依赖，后对齐执行器无法加载。'
            );
          }
          return createStatusDetail(
            true,
            'ready',
            'Qwen3 Forced Aligner 模型文件与 qwen-asr 运行时已就绪。当前可作为 transcript-only ASR 的后对齐执行器使用。'
          );
        };
        const qwenAlignerDetail = getQwenAlignerStatusDetail();
        const indexTtsDetail = getIndexTtsStatusDetail();
        const qwenTokenizerDetail = getQwenTokenizerStatusDetail();
        const qwen17BBaseDetail = getQwenTtsModelStatusDetail('Qwen3-TTS-12Hz-1.7B-Base', 'Qwen3-TTS 1.7B Base');
        const qwen17BDesignDetail = getQwenTtsModelStatusDetail('Qwen3-TTS-12Hz-1.7B-VoiceDesign', 'Qwen3-TTS 1.7B VoiceDesign');
        const qwen17BCustomDetail = getQwenTtsModelStatusDetail('Qwen3-TTS-12Hz-1.7B-CustomVoice', 'Qwen3-TTS 1.7B CustomVoice');
        const qwen06BBaseDetail = getQwenTtsModelStatusDetail('Qwen3-TTS-12Hz-0.6B-Base', 'Qwen3-TTS 0.6B Base');
        const qwen06BCustomDetail = getQwenTtsModelStatusDetail('Qwen3-TTS-12Hz-0.6B-CustomVoice', 'Qwen3-TTS 0.6B CustomVoice');
        const sourceSeparationDetail = getSourceSeparationStatusDetail();
        const rifeDetail = getRifeStatusDetail();

        // Specific checks
        const status = {
          faster_whisper_runtime: fasterWhisperRuntimeDetail.installed,
          funasr_runtime: funAsrRuntimeDetail.installed,
          transformers5_asr_runtime: transformers5AsrRuntimeDetail.installed,
          faster_whisper_model: fasterWhisperQualityDetail.installed,
          funasr_vad: funAsrVadDetail.installed,
          funasr_punc: funAsrPuncDetail.installed,
          faster_whisper_balanced_model: fasterWhisperBalancedDetail.installed,
          funasr_standard: funAsrDetail.installed,
          vibevoice_asr_standard: vibeVoiceAsrDetail.installed,
          index_tts: indexTtsDetail.installed,
          source_separation: sourceSeparationDetail.installed,
          qwen: checkDir(['Qwen2.5-7B-Instruct', 'qwen/Qwen2.5-7B-Instruct']),
          qwen_tokenizer: qwenTokenizerDetail.installed,
          qwen_17b_base: qwen17BBaseDetail.installed,
          qwen_17b_design: qwen17BDesignDetail.installed,
          qwen_17b_custom: qwen17BCustomDetail.installed,
          qwen_06b_base: qwen06BBaseDetail.installed,
          qwen_06b_custom: qwen06BCustomDetail.installed,
          qwen_asr_06b: qwenAsr06BDetail.installed,
          qwen_asr_17b: qwenAsr17BDetail.installed,
          qwen_asr_aligner: qwenAlignerDetail.installed,
          rife: rifeDetail.installed
        };

        const statusDetails = {
          faster_whisper_runtime: {
            state: fasterWhisperRuntimeDetail.state,
            detail: fasterWhisperRuntimeDetail.detail,
            repairable: fasterWhisperRuntimeDetail.repairable,
          },
          funasr_runtime: funAsrRuntimeDetail,
          transformers5_asr_runtime: {
            state: transformers5AsrRuntimeDetail.state,
            detail: transformers5AsrRuntimeDetail.detail,
            repairable: transformers5AsrRuntimeDetail.repairable,
          },
          faster_whisper_model: fasterWhisperQualityDetail,
          faster_whisper_balanced_model: fasterWhisperBalancedDetail,
          funasr_standard: funAsrDetail,
          funasr_vad: funAsrVadDetail,
          funasr_punc: funAsrPuncDetail,
          qwen_asr_06b: qwenAsr06BDetail,
          qwen_asr_17b: qwenAsr17BDetail,
          qwen_asr_aligner: qwenAlignerDetail,
          vibevoice_asr_standard: {
            state: vibeVoiceAsrDetail.state,
            detail: vibeVoiceAsrDetail.detail,
            repairable: vibeVoiceAsrDetail.repairable,
          },
          index_tts: indexTtsDetail,
          qwen_tokenizer: qwenTokenizerDetail,
          qwen_17b_base: qwen17BBaseDetail,
          qwen_17b_design: qwen17BDesignDetail,
          qwen_17b_custom: qwen17BCustomDetail,
          qwen_06b_base: qwen06BBaseDetail,
          qwen_06b_custom: qwen06BCustomDetail,
          source_separation: {
            state: sourceSeparationDetail.state,
            detail: sourceSeparationDetail.detail,
            repairable: sourceSeparationDetail.repairable,
          },
          rife: {
            state: rifeDetail.state,
            detail: rifeDetail.detail,
            repairable: rifeDetail.repairable,
          },
        };

        resolve({ success: true, status, status_details: statusDetails, root: modelsRoot });

      } catch (e: unknown) {
        resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });

  // IPC Handler to check file existence (Robust check)
  ipcMain.handle('check-file-exists', async (_event, filePath: string) => {
    try {
      if (!filePath) return false;
      return fs.existsSync(filePath);
    } catch (e) {
      logMainError('检查文件存在性失败', {
        domain: 'filesystem',
        action: 'check-file-exists',
        detail: e instanceof Error ? e.message : String(e)
      })
      return false;
    }
  });


  // IPC Handler to Cancel Download
  // IPC Handler to Cancel Download
  ipcMain.handle('cancel-download', async (_event, args) => {
    const { key, model } = args; // Expect key, fallback to model
    const trackingKey = key || model;

    const proc = activeDownloads.get(trackingKey);
    if (proc) {
      logMainSecurity('取消模型下载任务', {
        domain: 'download.lifecycle',
        action: 'cancel-download',
        detail: `${trackingKey} pid=${proc.pid}`
      })

      // Force kill
      if (process.platform === 'win32' && proc.pid) {
        exec(`taskkill /pid ${proc.pid} /T /F`, (err) => {
          if (err) {
            logMainError('取消模型下载时 taskkill 失败', {
              domain: 'download.lifecycle',
              action: 'cancel-download',
              detail: err.message
            })
          }
        });
      }

      proc.kill(); // Fallback/Standard kill
      activeDownloads.delete(trackingKey);
      return { success: true };
    }
    return { success: false, error: 'Download not found' };
  });

  // IPC Handler to cancel general file download
  ipcMain.handle('cancel-file-download', async (_event, args) => {
    const { key } = args;
    // Re-use logic if possible, or maintain separate map
    const proc = activeDownloads.get(key);
    if (proc) {
      logMainSecurity('取消文件下载任务', {
        domain: 'download.lifecycle',
        action: 'cancel-file-download',
        detail: `${key} pid=${proc.pid}`
      })
      if (process.platform === 'win32' && proc.pid) {
        exec(`taskkill /pid ${proc.pid} /T /F`, () => { });
      }
      proc.kill();
      activeDownloads.delete(key);
      return { success: true };
    }
    return { success: false, error: 'Not found' };
  });

  // IPC Handler for Generic File Download (e.g. RIFE ncnn)
  ipcMain.handle('download-file', async (_event, args) => {
    return new Promise((resolve) => {
      try {
        const { url, targetDir, key, name, outputFileName, baseDir } = args;
        const { modelsRoot, projectRoot } = resolveModelsRoot();

        const baseRoot = baseDir === 'project' ? projectRoot : modelsRoot;
        const finalDir = path.join(baseRoot, targetDir);
        if (!fs.existsSync(finalDir)) {
          fs.mkdirSync(finalDir, { recursive: true });
        }

        logMainBusiness('启动文件下载任务', {
          domain: 'download.lifecycle',
          action: 'download-file',
          detail: `${name} -> ${finalDir}`
        })

        const pythonExe = getPythonExe(projectRoot);

        const safeFinalDir = finalDir.replace(/\\/g, '\\\\');
        const safe7zaPath = path7za.replace(/\\/g, '\\\\');
        const script = `
import sys
import os
import urllib.parse
import zipfile
import shutil
import subprocess
import time
import requests

url = "${url}"
out_dir = r"${safeFinalDir}"
archive_ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower() or ".bin"
archive_path = os.path.join(out_dir, "temp_download" + archive_ext)
archive_part_path = archive_path + ".part"
single_file_name = ${JSON.stringify(outputFileName || '')}
single_file_path = os.path.join(out_dir, single_file_name) if single_file_name else ""
single_file_part_path = single_file_path + ".part" if single_file_name else ""
seven_zip_exe = r"${safe7zaPath}"

def flatten_single_nested_dir(root_dir):
    entries = [entry for entry in os.listdir(root_dir) if entry not in ('.DS_Store', '__MACOSX')]
    if len(entries) != 1:
        return
    nested_path = os.path.join(root_dir, entries[0])
    if not os.path.isdir(nested_path):
        return

    for child_name in os.listdir(nested_path):
        src = os.path.join(nested_path, child_name)
        dst = os.path.join(root_dir, child_name)
        if os.path.exists(dst):
            if os.path.isdir(dst):
                shutil.rmtree(dst)
            else:
                os.remove(dst)
        shutil.move(src, dst)
    shutil.rmtree(nested_path, ignore_errors=True)

def stream_download(download_url, destination_path, label):
    temp_path = destination_path + ".part"
    if os.path.exists(temp_path):
        os.remove(temp_path)

    max_attempts = 3
    chunk_size = 1024 * 1024
    timeout = (20, 120)

    for attempt in range(1, max_attempts + 1):
        downloaded = 0
        last_percent = -1
        try:
            print(f"PROGRESS:0:{label} 准备下载", flush=True)
            with requests.get(download_url, stream=True, timeout=timeout, allow_redirects=True) as response:
                response.raise_for_status()
                total_size = int(response.headers.get("Content-Length", "0") or 0)
                with open(temp_path, "wb") as handle:
                    for chunk in response.iter_content(chunk_size=chunk_size):
                        if not chunk:
                            continue
                        handle.write(chunk)
                        downloaded += len(chunk)
                        percent = int(downloaded * 100 / total_size) if total_size > 0 else 0
                        if percent != last_percent:
                            print(f"PROGRESS:{min(percent, 100)}:{label}", flush=True)
                            last_percent = percent
            if total_size > 0 and downloaded != total_size:
                raise RuntimeError(f"Incomplete download: expected {total_size} bytes, got {downloaded} bytes")
            os.replace(temp_path, destination_path)
            print(f"PROGRESS:100:{label}", flush=True)
            return
        except Exception as exc:
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
            if attempt >= max_attempts:
                raise RuntimeError(f"{label} 下载失败，已重试 {max_attempts} 次：{exc}") from exc
            print(f"RETRY:{attempt}:{label}:{exc}", flush=True)
            time.sleep(min(5 * attempt, 10))

try:
    print(f"Downloading {url}...")
    if single_file_name:
        stream_download(url, single_file_path, single_file_name)
        print(f"Saved file to {single_file_path}")
    else:
        stream_download(url, archive_path, os.path.basename(archive_path))
        print("PROGRESS:100:下载完成，开始解压", flush=True)
        print("Download complete. Extracting...")
        if archive_ext == ".zip":
            with zipfile.ZipFile(archive_path, 'r') as zip_ref:
                zip_ref.extractall(out_dir)
        elif archive_ext == ".7z":
            subprocess.run([seven_zip_exe, 'x', archive_path, '-o' + out_dir, '-y'], check=True)
        else:
            raise RuntimeError(f"Unsupported archive format: {archive_ext}")
        flatten_single_nested_dir(out_dir)
        print("PROGRESS:100:解压完成", flush=True)
        print("Extraction complete.")
        os.remove(archive_path)
    print("SUCCESS")
except Exception as e:
    for leftover_path in (archive_part_path, single_file_part_path):
        if leftover_path and os.path.exists(leftover_path):
            try:
                os.remove(leftover_path)
            except OSError:
                pass
    print(f"ERROR: {e}")
`;
        const proc = spawn(pythonExe, ['-c', script], {
          env: getPythonProcessEnv()
        });

        if (key) activeDownloads.set(key, proc);

        let output = '';
        let errorOut = '';

        proc.stdout.on('data', (data) => {
          const s = normalizeKnownProcessMessage(decodeProcessChunk(data));
          logMainDebug('文件下载标准输出', {
            domain: 'download.lifecycle',
            action: 'download-file',
            detail: s.trim()
          })
          output += s;
          const progressEvent = extractModelDownloadProgress(s);
          if (progressEvent && key) {
            emitModelDownloadProgress(_event.sender, key, progressEvent);
          }
        });
        proc.stderr.on('data', (data) => {
          const s = normalizeKnownProcessMessage(decodeProcessChunk(data));
          logMainWarn('文件下载标准错误输出', {
            domain: 'download.lifecycle',
            action: 'download-file',
            detail: s.trim()
          })
          errorOut += s;
          const progressEvent = extractModelDownloadProgress(s);
          if (progressEvent && key) {
            emitModelDownloadProgress(_event.sender, key, progressEvent);
          }
        });

        proc.on('close', (code) => {
          if (key) activeDownloads.delete(key);
          if (code === 0 && output.includes('SUCCESS') && key) {
            emitModelDownloadProgress(_event.sender, key, {
              percent: 100,
              phase: 'completed',
              message: '下载完成'
            });
          }
          if (code === 0 && output.includes('SUCCESS')) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `Failed (Code ${code})\n${errorOut}\n${output}` });
          }
        });

      } catch (e: unknown) {
        resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });

  ipcMain.handle('install-transformers5-asr-runtime', async (_event, args) => {
    return new Promise((resolve) => {
      try {
        const trackingKey = args?.key || 'transformers5_asr_runtime';
        const { projectRoot } = resolveModelsRoot();
        const targetDir = path.join(projectRoot, 'runtime', 'overlays', 'transformers5_asr');
        const legacyDirs = [
          path.join(projectRoot, 'storage', 'runtime', 'transformers5_asr'),
          path.join(projectRoot, 'storage', 'cache', 'transformers5_asr_overlay')
        ];

        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        const pythonExe = getPythonExe(projectRoot);
        const safeTargetDir = targetDir.replace(/\\/g, '\\\\');
        const safeLegacyDirsJson = JSON.stringify(legacyDirs.map((candidate) => candidate.replace(/\\/g, '\\\\')));
        const script = `
import os
import shutil
import subprocess
import sys

target_dir = r"${safeTargetDir}"
legacy_dirs = ${safeLegacyDirsJson}
packages = [
    "transformers==5.7.0",
]

def emit(percent, message):
    print(f"PROGRESS:{percent}:{message}", flush=True)

def remove_path(target):
    if not os.path.exists(target):
        return
    if os.path.isdir(target):
        shutil.rmtree(target, ignore_errors=True)
    else:
        try:
            os.remove(target)
        except OSError:
            pass

def clean_transformers_overlay(root_dir):
    if not os.path.isdir(root_dir):
        return
    for name in list(os.listdir(root_dir)):
        lower = name.lower()
        if lower == "transformers" or lower.startswith("transformers-"):
            remove_path(os.path.join(root_dir, name))

def prune_scientific_stack(root_dir):
    if not os.path.isdir(root_dir):
        return
    for name in list(os.listdir(root_dir)):
        lower = name.lower()
        if lower == "numpy" or lower.startswith("numpy-"):
            remove_path(os.path.join(root_dir, name))

emit(5, "准备安装共享 Transformers 5.x ASR Runtime")
os.makedirs(target_dir, exist_ok=True)
clean_transformers_overlay(target_dir)

for package in packages:
    emit(15, f"正在安装 {package}")
    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--upgrade",
        "--target",
        target_dir,
        "--no-warn-script-location",
        package,
    ]
    subprocess.check_call(command)

prune_scientific_stack(target_dir)
emit(85, "已移除 overlay 内的科学计算基础包，避免污染主 runtime")

for legacy_dir in legacy_dirs:
    if os.path.isdir(legacy_dir):
        try:
            shutil.rmtree(legacy_dir, ignore_errors=True)
        except OSError:
            pass

emit(100, "共享 Transformers 5.x ASR Runtime 安装完成")
print("SUCCESS", flush=True)
`;

        const proc = spawn(pythonExe, ['-c', script], {
          env: getPythonProcessEnv()
        });

        activeDownloads.set(trackingKey, proc);
        emitModelDownloadProgress(_event.sender, trackingKey, {
          percent: 0,
          phase: 'installing',
          message: '准备安装共享 Transformers 5.x ASR Runtime'
        });

        let output = '';
        let errorOut = '';

        proc.stdout.on('data', (data) => {
          const s = normalizeKnownProcessMessage(decodeProcessChunk(data));
          output += s;
          const progressEvent = extractModelDownloadProgress(s);
          if (progressEvent) {
            emitModelDownloadProgress(_event.sender, trackingKey, {
              ...progressEvent,
              phase: progressEvent.phase === 'completed' ? 'completed' : 'installing'
            });
          }
        });

        proc.stderr.on('data', (data) => {
          const s = normalizeKnownProcessMessage(decodeProcessChunk(data));
          errorOut += s;
        });

        proc.on('close', (code) => {
          activeDownloads.delete(trackingKey);
          if (code === 0 && output.includes('SUCCESS')) {
            emitModelDownloadProgress(_event.sender, trackingKey, {
              percent: 100,
              phase: 'completed',
              message: '共享 Transformers 5.x ASR Runtime 安装完成'
            });
            resolve({ success: true });
            return;
          }

          emitModelDownloadProgress(_event.sender, trackingKey, {
            phase: 'failed',
            message: '共享 Transformers 5.x ASR Runtime 安装失败'
          });
          resolve({ success: false, error: `Failed (Code ${code})\n${errorOut}\n${output}` });
        });
      } catch (e: unknown) {
        resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });

  ipcMain.handle('install-funasr-runtime', async (_event, args) => {
    return new Promise((resolve) => {
      try {
        const trackingKey = args?.key || 'funasr_runtime';
        const { projectRoot } = resolveModelsRoot();
        const pythonExe = getPythonExe(projectRoot);
        const script = `
import subprocess
import sys

packages = [
    "funasr",
]

def emit(percent, message):
    print(f"PROGRESS:{percent}:{message}", flush=True)

emit(5, "准备安装 FunASR Python Runtime")
for index, package in enumerate(packages, start=1):
    emit(20 + index * 40, f"正在安装 {package}")
    subprocess.check_call([
        sys.executable,
        "-m",
        "pip",
        "install",
        "--upgrade",
        "--no-warn-script-location",
        package,
    ])

emit(100, "FunASR Python Runtime 安装完成")
print("SUCCESS", flush=True)
`;

        const proc = spawn(pythonExe, ['-c', script], {
          env: getPythonProcessEnv()
        });

        activeDownloads.set(trackingKey, proc);
        emitModelDownloadProgress(_event.sender, trackingKey, {
          percent: 0,
          phase: 'installing',
          message: '准备安装 FunASR Python Runtime'
        });

        let output = '';
        let errorOut = '';

        proc.stdout.on('data', (data) => {
          const s = normalizeKnownProcessMessage(decodeProcessChunk(data));
          output += s;
          const progressEvent = extractModelDownloadProgress(s);
          if (progressEvent) {
            emitModelDownloadProgress(_event.sender, trackingKey, {
              ...progressEvent,
              phase: progressEvent.phase === 'completed' ? 'completed' : 'installing'
            });
          }
        });

        proc.stderr.on('data', (data) => {
          const s = normalizeKnownProcessMessage(decodeProcessChunk(data));
          errorOut += s;
        });

        proc.on('close', (code) => {
          activeDownloads.delete(trackingKey);
          if (code === 0 && output.includes('SUCCESS')) {
            emitModelDownloadProgress(_event.sender, trackingKey, {
              percent: 100,
              phase: 'completed',
              message: 'FunASR Python Runtime 安装完成'
            });
            resolve({ success: true });
            return;
          }

          emitModelDownloadProgress(_event.sender, trackingKey, {
            phase: 'failed',
            message: 'FunASR Python Runtime 安装失败'
          });
          resolve({ success: false, error: `Failed (Code ${code})\n${errorOut}\n${output}` });
        });
      } catch (e: unknown) {
        resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });

  // Helper to resolve python path (refactored from download-model)
  function getPythonExe(projectRoot: string) {
    const candidates = app.isPackaged
      ? [
          path.join(process.resourcesPath, 'python', 'python.exe'),
          path.join(projectRoot, 'runtime', 'python', 'python.exe'),
          path.join(projectRoot, 'python', 'python.exe')
        ]
      : [
          path.join(projectRoot, 'runtime', 'python', 'python.exe'),
          path.join(projectRoot, 'python', 'python.exe')
        ]

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }
    return 'python'
  }

  // IPC Handler for Model Download
  ipcMain.handle('download-model', async (_event, args) => {
    return new Promise((resolve) => {
      try {
        const { model, localDir, key } = args;
        const trackingKey = key || model;

        // Resolve closest/active models root
        const { modelsRoot, projectRoot } = resolveModelsRoot();

        // subpath should be relative to models directory, but args.localDir 'models/index-tts/hub' includes 'models/'
        // We need to strip 'models/' prefix if we are joining with modelsRoot
        const relativePath = localDir.replace(/^models[\\/]/, '');
        const targetPath = path.join(modelsRoot, relativePath);

        logMainBusiness('启动模型下载任务', {
          domain: 'download.lifecycle',
          action: 'download-model',
          detail: targetPath
        })

        // Ensure directory exists
        if (!fs.existsSync(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true });
        }

        const pythonExe = getPythonExe(projectRoot);

        // Construct Python Script
        // We use python -c to run modelscope download
        // Escape backslashes for python string
        const safeTarget = targetPath.replace(/\\/g, '\\\\');
        const script = `
try:
    model_id = '${model}'
    target_dir = '${safeTarget}'
    print(f"Downloading {model_id} to {target_dir}...")
    if model_id.startswith('hf://'):
        import os
        import time
        import requests
        from huggingface_hub import HfApi, hf_hub_url
        from huggingface_hub.utils import build_hf_headers
        repo_id = model_id[len('hf://'):]
        api = HfApi()
        info = api.model_info(repo_id=repo_id, files_metadata=True)
        siblings = [item for item in (info.siblings or []) if getattr(item, 'rfilename', None)]
        total_bytes = 0
        for item in siblings:
            try:
                total_bytes += int(getattr(item, 'size', 0) or 0)
            except Exception:
                pass
        downloaded_bytes = 0
        file_count = max(len(siblings), 1)
        progress_state = {'last_percent': -1}

        def format_bytes(num_bytes):
            value = float(max(num_bytes, 0))
            units = ['B', 'KB', 'MB', 'GB', 'TB']
            unit_index = 0
            while value >= 1024 and unit_index < len(units) - 1:
                value /= 1024.0
                unit_index += 1
            return f"{value:.1f}{units[unit_index]}"

        def emit_progress(current_file, status_text):
            if total_bytes > 0:
                percent = min(100, int(downloaded_bytes * 100 / total_bytes))
                summary = f"{current_file} | {status_text} | {format_bytes(downloaded_bytes)}/{format_bytes(total_bytes)}"
            else:
                percent = min(100, int(file_index * 100 / file_count))
                summary = f"{current_file} | {status_text}"
            if percent != progress_state['last_percent'] or status_text.startswith('准备') or status_text.startswith('完成') or status_text.startswith('跳过'):
                print(f"PROGRESS:{percent}:{summary}", flush=True)
                progress_state['last_percent'] = percent

        headers = build_hf_headers()
        for index, item in enumerate(siblings, start=1):
            filename = item.rfilename
            file_size = int(getattr(item, 'size', 0) or 0)
            file_index = index
            final_path = os.path.join(target_dir, filename.replace('/', os.sep))
            os.makedirs(os.path.dirname(final_path), exist_ok=True)

            if file_size > 0 and os.path.exists(final_path) and os.path.getsize(final_path) == file_size:
                downloaded_bytes += file_size
                emit_progress(filename, '跳过已存在文件')
                continue

            temp_path = final_path + '.part'
            if os.path.exists(temp_path):
                os.remove(temp_path)

            file_downloaded = 0
            emit_progress(filename, '准备下载')
            download_url = hf_hub_url(repo_id=repo_id, filename=filename)
            last_file_percent = -1
            max_attempts = 3
            for attempt in range(1, max_attempts + 1):
                try:
                    with requests.get(download_url, headers=headers, stream=True, timeout=(20, 120), allow_redirects=True) as response:
                        response.raise_for_status()
                        expected_size = int(response.headers.get('Content-Length', '0') or 0) or file_size
                        file_downloaded = 0
                        with open(temp_path, 'wb') as handle:
                            for chunk in response.iter_content(chunk_size=1024 * 1024):
                                if not chunk:
                                    continue
                                handle.write(chunk)
                                chunk_len = len(chunk)
                                file_downloaded += chunk_len
                                downloaded_bytes += chunk_len
                                current_file_percent = int(file_downloaded * 100 / expected_size) if expected_size > 0 else -1
                                if current_file_percent != last_file_percent:
                                    emit_progress(filename, f'下载中 {max(current_file_percent, 0)}%')
                                    last_file_percent = current_file_percent
                        if expected_size > 0 and file_downloaded != expected_size:
                            raise RuntimeError(f'incomplete file: expected {expected_size} bytes, got {file_downloaded} bytes')
                    os.replace(temp_path, final_path)
                    if file_size > 0 and file_downloaded != file_size:
                        downloaded_bytes += max(file_size - file_downloaded, 0)
                    emit_progress(filename, '完成')
                    break
                except Exception as download_error:
                    downloaded_bytes -= file_downloaded
                    file_downloaded = 0
                    if os.path.exists(temp_path):
                        try:
                            os.remove(temp_path)
                        except OSError:
                            pass
                    if attempt >= max_attempts:
                        raise RuntimeError(f'{filename} 下载失败，已重试 {max_attempts} 次：{download_error}') from download_error
                    emit_progress(filename, f'重试 {attempt}/{max_attempts}')
                    time.sleep(min(5 * attempt, 10))
    else:
        from modelscope.hub.snapshot_download import snapshot_download
        print("PROGRESS:0:准备连接 ModelScope", flush=True)
        snapshot_download(model_id, local_dir=target_dir)
        print("PROGRESS:100:ModelScope 下载完成", flush=True)
    print("SUCCESS")
except Exception as e:
    print(f"ERROR: {e}")
`;

        // Log to logs/backend_debug.log
        const logFile = path.join(getLogsDir(projectRoot), 'backend_debug.log');
        const logDir = path.dirname(logFile);
        if (!fs.existsSync(logDir)) {
          try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {
            logMainError('创建下载日志目录失败', {
              domain: 'download.lifecycle',
              action: 'download-model',
              detail: e instanceof Error ? e.message : String(e)
            })
          }
        }

        let logStream: fs.WriteStream | null = null;
        try {
          logStream = fs.createWriteStream(logFile, { flags: 'a' });
          logStream.write(`\n[${new Date().toISOString()}] [DownloadModel] Starting download: ${model} -> ${targetPath}\n`);
        } catch (e) {
          logMainError('创建下载日志流失败', {
            domain: 'download.lifecycle',
            action: 'download-model',
            detail: e instanceof Error ? e.message : String(e)
          })
        }

        const proc = spawn(pythonExe, ['-c', script], {
          env: getPythonProcessEnv()
        });

        activeDownloads.set(trackingKey, proc);

        let output = '';
        let errorOut = '';

        proc.stdout.on('data', (data) => {
          const s = normalizeKnownProcessMessage(decodeProcessChunk(data));
          logMainDebug('模型下载标准输出', {
            domain: 'download.lifecycle',
            action: 'download-model',
            detail: s.trim()
          })
          output += s;
          if (logStream) logStream.write(s);
          const progressEvent = extractModelDownloadProgress(s);
          if (progressEvent) {
            emitModelDownloadProgress(_event.sender, trackingKey, progressEvent);
          }
        });
        proc.stderr.on('data', (data) => {
          const s = normalizeKnownProcessMessage(decodeProcessChunk(data));
          logMainWarn('模型下载标准错误输出', {
            domain: 'download.lifecycle',
            action: 'download-model',
            detail: s.trim()
          })
          errorOut += s;
          if (logStream) logStream.write(`[STDERR] ${s}`);
          const progressEvent = extractModelDownloadProgress(s);
          if (progressEvent) {
            emitModelDownloadProgress(_event.sender, trackingKey, progressEvent);
          }
        });

        proc.on('close', (code) => {
          if (activeDownloads.has(trackingKey)) {
            activeDownloads.delete(trackingKey);
          }
          if (logStream) {
            logStream.write(`\n[${new Date().toISOString()}] [DownloadModel] Finished with code ${code}\n`);
            logStream.end();
          }

          if (code === 0 && output.includes('SUCCESS')) {
            emitModelDownloadProgress(_event.sender, trackingKey, {
              percent: 100,
              phase: 'completed',
              message: '下载完成'
            });
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `Process failed (Code ${code}). \n${errorOut}\n${output}` });
          }
        });

      } catch (e: unknown) {
        resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
})
