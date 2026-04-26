import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { spawn, exec, execFile, ChildProcess } from 'child_process'
import fs from 'fs'

const activeDownloads = new Map<string, ChildProcess>();
const VERBOSE_MAIN_LOGS = process.env.VSM_VERBOSE_MAIN === '1'

type MainLogLevel = 'info' | 'warn' | 'error' | 'debug'
type MainLogType = 'business' | 'error' | 'security' | 'debug'

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

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    logger: 'electron.main',
    domain: fields.domain,
    log_type: logType,
    message,
    action: fields.action || '-',
    event: fields.event,
    stage: fields.stage,
    code: fields.code,
    detail: fields.detail
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

function decodeProcessChunk(data: any) {
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
  payload?: Record<string, any>
  context?: Record<string, any>
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
    || normalized.includes('cuda')
}

function inferMirroredBackendLineLevel(
  source: 'stdout' | 'stderr',
  line: string
): 'info' | 'warn' | 'error' {
  const normalized = String(line || '').toLowerCase()
  const hasWarning = /\bwarning\b|\bwarn\b/i.test(normalized)
  const hasHardError = /\btraceback\b|\bexception\b|\bfatal\b|\bcuda\b/i.test(normalized)
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
    PYTHONIOENCODING: 'utf-8',
    NUMBA_DISABLE_INTEL_SVML: '1',
    NUMBA_CPU_NAME: 'generic'
  }

  try {
    const projectRoot = getProjectRoot()
    const sitePackages = path.join(projectRoot, 'python', 'Lib', 'site-packages')
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

function getProjectRoot() {
  return app.isPackaged
    ? path.dirname(process.resourcesPath)
    : path.resolve(process.env.APP_ROOT, '..')
}

function ensureElectronStoragePaths() {
  const projectRoot = getProjectRoot()
  const electronDataDir = path.join(projectRoot, '.cache', 'electron')
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
  const preferredRoots = [
    app.getPath('videos'),
    app.getPath('documents'),
    app.getPath('downloads'),
    app.getPath('home')
  ].filter(Boolean)

  const baseDir = preferredRoots[0] || getProjectRoot()
  return path.join(baseDir, 'VideoSync')
}

ensureElectronStoragePaths()

function getAppPaths() {
  const projectRoot = getProjectRoot()
  return {
    projectRoot,
    outputDir: getDefaultOutputDir(),
    cacheDir: path.join(projectRoot, '.cache')
  }
}

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

function createBackendRequestError(workerResult: any) {
  const message = workerResult?.error || workerResult?.error_info?.message || 'Backend worker request failed'
  const error = new Error(message) as Error & {
    code?: string
    error?: string
    error_info?: any
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

        const depsMatch = normalizedLine.match(/\[DEPS_INSTALLING\]\s*(.*)/)
        if (depsMatch) {
          const packageDesc = depsMatch[1].trim()
          workerState.activeRequest.sender.send('backend-deps-installing', packageDesc)
        }

        const depsDoneMatch = normalizedLine.match(/\[DEPS_DONE\]\s*(.*)/)
        if (depsDoneMatch) {
          workerState.activeRequest.sender.send('backend-deps-done')
        }
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

function consumeBackendProcessChunk(lane: BackendLane, chunk: string, source: 'stdout' | 'stderr') {
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
  const pythonExe = path.join(projectRoot, 'python', 'python.exe')
  const scriptPath = path.join(projectRoot, 'backend', 'main.py')
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

  backendProcess.stdout.on('data', (data: any) => {
    consumeBackendProcessChunk(lane, data, 'stdout')
  })

  backendProcess.stderr.on('data', (data: any) => {
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
  const bundled = path.join(projectRoot, 'backend', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  return fs.existsSync(bundled) ? bundled : 'ffprobe'
}

function analyzeVideoWithFfprobe(filePath: string): Promise<any> {
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
          const videoStream = streams.find((stream: any) => stream?.codec_type === 'video') || {}
          const audioStream = streams.find((stream: any) => stream?.codec_type === 'audio') || {}

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
        } catch (parseError: any) {
          reject(new Error(`Failed to parse ffprobe output: ${parseError?.message || String(parseError)}`))
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
    // ... existing createWindow code ...
  win = new BrowserWindow({
    width: 1720,
    height: 980,
    minWidth: 1680,
    minHeight: 900,
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
  ipcMain.handle('save-file', async (_event: any, filePath: string, content: string) => {
    return new Promise((resolve, reject) => {
      fs.writeFile(filePath, content, 'utf-8', (err: any) => {
        if (err) reject(err)
        else resolve(true)
      })
    })
  })

  ipcMain.handle('read-file', async (_event: any, filePath: string) => {
    return new Promise((resolve, reject) => {
      fs.readFile(filePath, 'utf-8', (err: any, content: string) => {
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
  ipcMain.handle('ensure-dir', async (_event: any, dirPath: string) => {
    return new Promise((resolve, reject) => {
      fs.mkdir(dirPath, { recursive: true }, (err: any) => {
        if (err) reject(err)
        else resolve(true)
      })
    })
  })

  ipcMain.handle('delete-path', async (_event: any, targetPath: string) => {
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
    async (_event: any, payload: { sessionCacheDir: string; mode: 'success' | 'failed' | 'interrupted' }) => {
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
  ipcMain.handle('run-backend', async (_event: any, payload: any) => {
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
      let projectRoot;
      if (app.isPackaged) {
        projectRoot = path.dirname(process.resourcesPath);
      } else {
        projectRoot = path.resolve(process.env.APP_ROOT, '..');
      }

      const logPath = path.join(projectRoot, 'logs', 'backend_debug.log');

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

  // IPC Handler to repair python environment
  ipcMain.handle('fix-python-env', async (_event) => {
    return new Promise((resolve) => {
      try {
        const projectRoot = app.isPackaged
          ? path.dirname(process.resourcesPath)
          : path.resolve(process.env.APP_ROOT, '..');

        const pythonExe = path.join(projectRoot, 'python', 'python.exe');
        const requirementsPath = path.join(projectRoot, 'requirements.txt');

        if (!fs.existsSync(pythonExe)) {
          resolve({ success: false, error: `找不到 Python 解释器。请确认 python 文件夹存在于 ${projectRoot}` });
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

      } catch (e: any) {
        resolve({ success: false, error: e.message });
      }
    });
  })

  // IPC Handler to check python environment (list missing deps)
  ipcMain.handle('check-python-env', async (_event) => {
    return new Promise((resolve) => {
      try {
        const projectRoot = app.isPackaged
          ? path.dirname(process.resourcesPath)
          : path.resolve(process.env.APP_ROOT, '..');

        const pythonExe = path.join(projectRoot, 'python', 'python.exe');
        const requirementsPath = path.join(projectRoot, 'requirements.txt');
        const checkScriptPath = path.join(projectRoot, 'backend', 'check_requirements.py');

        if (!fs.existsSync(pythonExe)) {
          resolve({ success: false, status: 'missing_python', error: `找不到 Python 解释器。请确认 python 文件夹存在于 ${projectRoot}` });
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
          } catch (e: any) {
            resolve({ success: false, error: `Parse error: ${e.message}` });
          }
        });

        checkProcess.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });

      } catch (e: any) {
        resolve({ success: false, error: e.message });
      }
    });
  })

  // Helper function to resolve Models Root
  const resolveModelsRoot = () => {
    let modelsRoot = '';
    let projectRoot = '';

    if (app.isPackaged) {
      projectRoot = path.dirname(process.resourcesPath);
      if (process.env.PORTABLE_EXECUTABLE_DIR) {
        modelsRoot = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'models');
      } else {
        modelsRoot = path.join(projectRoot, 'models');
      }
    } else {
      // In Dev: Strict Project Root Only
      projectRoot = path.resolve(process.env.APP_ROOT, '..');
      modelsRoot = path.join(projectRoot, 'models');
    }
    return { modelsRoot, projectRoot };
  };

  // IPC Handler to check model status
  ipcMain.handle('check-model-status', async (_event) => {
    return new Promise((resolve) => {
      try {
        const { modelsRoot } = resolveModelsRoot();
        logMainDebug('检查模型目录状态', {
          domain: 'model.lifecycle',
          action: 'check-model-status',
          detail: modelsRoot
        })

        const checkDir = (subpath: string[]) => {
          // Check variations
          for (const p of subpath) {
            const fullPath = path.join(modelsRoot, p);
            if (fs.existsSync(fullPath)) return true;
          }
          return false;
        };

        // Specific checks
        const status = {
          whisperx: checkDir(['faster-whisper-large-v3-turbo-ct2', 'whisperx/faster-whisper-large-v3-turbo-ct2']),
          alignment: checkDir(['alignment']),
          index_tts: checkDir(['index-tts', 'index-tts/hub']),
          source_separation: checkDir(['source_separation/hdemucs_high_musdb_plus.pt']),
          qwen: checkDir(['Qwen2.5-7B-Instruct', 'qwen/Qwen2.5-7B-Instruct']),
          qwen_tokenizer: checkDir(['Qwen3-TTS-Tokenizer-12Hz', 'Qwen/Qwen3-TTS-Tokenizer-12Hz']),
          qwen_17b_base: checkDir(['Qwen3-TTS-12Hz-1.7B-Base', 'Qwen/Qwen3-TTS-12Hz-1.7B-Base']),
          qwen_17b_design: checkDir(['Qwen3-TTS-12Hz-1.7B-VoiceDesign', 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign']),
          qwen_17b_custom: checkDir(['Qwen3-TTS-12Hz-1.7B-CustomVoice', 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice']),
          qwen_06b_base: checkDir(['Qwen3-TTS-12Hz-0.6B-Base', 'Qwen/Qwen3-TTS-12Hz-0.6B-Base']),
          qwen_06b_custom: checkDir(['Qwen3-TTS-12Hz-0.6B-CustomVoice', 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice']),
          qwen_asr_06b: checkDir(['Qwen3-ASR-0.6B', 'Qwen/Qwen3-ASR-0.6B']),
          qwen_asr_17b: checkDir(['Qwen3-ASR-1.7B', 'Qwen/Qwen3-ASR-1.7B']),
          qwen_asr_aligner: checkDir(['Qwen3-ForcedAligner-0.6B', 'Qwen/Qwen3-ForcedAligner-0.6B']),
          rife: checkDir(['rife', 'rife-ncnn-vulkan'])
        };

        resolve({ success: true, status, root: modelsRoot });

      } catch (e: any) {
        resolve({ success: false, error: e.message });
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
        const { url, targetDir, key, name, outputFileName } = args;
        const { modelsRoot, projectRoot } = resolveModelsRoot();

        const finalDir = path.join(modelsRoot, targetDir);
        if (!fs.existsSync(finalDir)) {
          fs.mkdirSync(finalDir, { recursive: true });
        }

        logMainBusiness('启动文件下载任务', {
          domain: 'download.lifecycle',
          action: 'download-file',
          detail: `${name} -> ${finalDir}`
        })

        const pythonExe = getPythonExe(projectRoot);

        // Python script to download and unzip
        // Using python ensures we don't need extra node deps like 'adm-zip' or 'axios' if not bundled
        const script = `
import sys
import os
import urllib.request
import zipfile
import shutil

url = "${url}"
out_dir = r"${finalDir.replace(/\\/g, '\\\\')}"
zip_path = os.path.join(out_dir, "temp_download.zip")
single_file_name = ${JSON.stringify(outputFileName || '')}
single_file_path = os.path.join(out_dir, single_file_name) if single_file_name else ""

def progress(count, block_size, total_size):
    if total_size <= 0:
        percent = 0
    else:
        percent = int(count * block_size * 100 / total_size)
    # limit output freq
    if count % 100 == 0:
        print(f"PROGRESS:{percent}", flush=True)

try:
    print(f"Downloading {url}...")
    if single_file_name:
        urllib.request.urlretrieve(url, single_file_path, reporthook=progress)
        print(f"Saved file to {single_file_path}")
    else:
        urllib.request.urlretrieve(url, zip_path, reporthook=progress)
        print("Download complete. Extracting...")
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(out_dir)
        print("Extraction complete.")
        os.remove(zip_path)
    print("SUCCESS")
except Exception as e:
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
        });
        proc.stderr.on('data', (data) => {
          const s = normalizeKnownProcessMessage(decodeProcessChunk(data));
          logMainWarn('文件下载标准错误输出', {
            domain: 'download.lifecycle',
            action: 'download-file',
            detail: s.trim()
          })
          errorOut += s;
        });

        proc.on('close', (code) => {
          if (key) activeDownloads.delete(key);
          if (code === 0 && output.includes('SUCCESS')) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `Failed (Code ${code})\n${errorOut}` });
          }
        });

      } catch (e: any) {
        resolve({ success: false, error: e.message });
      }
    });
  });

  // Helper to resolve python path (refactored from download-model)
  function getPythonExe(projectRoot: string) {
    if (app.isPackaged) {
      let p = path.join(process.resourcesPath, 'python', 'python.exe');
      if (fs.existsSync(p)) return p;
      return path.join(projectRoot, 'python', 'python.exe');
    } else {
      let p = path.join(projectRoot, 'python', 'python.exe');
      if (fs.existsSync(p)) return p;
      return 'python';
    }
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

        // Determine python path
        let pythonExe = '';
        if (app.isPackaged) {
          pythonExe = path.join(process.resourcesPath, 'python', 'python.exe');
          if (!fs.existsSync(pythonExe)) {
            pythonExe = path.join(projectRoot, 'python', 'python.exe');
          }
        } else {
          if (fs.existsSync(path.join(projectRoot, 'python', 'python.exe'))) {
            pythonExe = path.join(projectRoot, 'python', 'python.exe');
          } else {
            pythonExe = 'python';
          }
        }

        // Construct Python Script
        // We use python -c to run modelscope download
        // Escape backslashes for python string
        const safeTarget = targetPath.replace(/\\/g, '\\\\');
        const script = `
try:
    from modelscope.hub.snapshot_download import snapshot_download
    model_id = '${model}'
    target_dir = '${safeTarget}'
    print(f"Downloading {model_id} to {target_dir}...")
    snapshot_download(model_id, local_dir=target_dir)
    print("SUCCESS")
except Exception as e:
    print(f"ERROR: {e}")
`;

        // Log to logs/backend_debug.log
        const logFile = path.join(projectRoot, 'logs', 'backend_debug.log');
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
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `Process failed (Code ${code}). \n${errorOut}\n${output}` });
          }
        });

      } catch (e: any) {
        resolve({ success: false, error: e.message });
      }
    });
  });
})
