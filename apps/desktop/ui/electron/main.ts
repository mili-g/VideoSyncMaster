import { app, BrowserWindow, ipcMain, shell, dialog, screen, safeStorage } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, createHmac, randomBytes, verify as cryptoVerify } from 'node:crypto'
import path from 'node:path'
import { spawn, exec, execFile, ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'node:os'

const activeDownloads = new Map<string, ChildProcess>();
const canceledDownloadKeys = new Set<string>()
type DownloadProgressPhase = 'preparing' | 'downloading' | 'extracting' | 'installing' | 'completed' | 'failed' | 'canceled'

interface DownloadTaskSnapshot {
  key: string
  active: boolean
  percent?: number
  phase?: DownloadProgressPhase
  message?: string
}

interface GitHubReleaseAssetSpec {
  owner: string
  repo: string
  tag: string
  assetPattern: string
}

interface ModelRootSettingsRecord {
  customModelsRoot?: string
}

interface RuntimeRootSettingsRecord {
  customRuntimeRoot?: string
}

interface ResolvedModelsRootInfo {
  projectRoot: string
  modelsRoot: string
  defaultModelsRoot: string
  managedModelsRoot: string
  configuredModelsRoot: string | null
  usingCustomRoot: boolean
  protectedDefaultRoot: boolean
}

interface ResolvedRuntimeRootInfo {
  projectRoot: string
  runtimeRoot: string
  defaultRuntimeRoot: string
  managedRuntimeRoot: string
  configuredRuntimeRoot: string | null
  usingCustomRoot: boolean
  protectedDefaultRoot: boolean
}

interface LicensePlanDefinition {
  id: string
  name: string
  cycle: 'monthly' | 'quarterly' | 'yearly'
  priceCny: number
  priceLabel: string
  seats: number
  description: string
  features: string[]
}

interface LicensePayloadRecord {
  schemaVersion: number
  licenseId: string
  product: string
  edition: string
  customerName: string
  customerEmail: string
  planId: string
  planName: string
  cycle: 'monthly' | 'quarterly' | 'yearly'
  priceCny: number
  currency: string
  issuedAt: string
  validFrom: string
  validUntil: string
  maxDevices: number
  features: string[]
  operator: string
  status: 'active' | 'suspended'
  notes?: string
  deviceBinding?: {
    mode: 'optional' | 'required'
    fingerprint?: string
    fingerprintVersion?: 'cpu-v1' | 'cpu-short-v1'
    label?: string
  }
}

interface LicenseEnvelopeRecord {
  signatureAlgorithm: 'ed25519'
  keyFingerprint: string
  payload: LicensePayloadRecord
  signature: string
}

interface MachineFingerprintInfoRecord {
  fingerprint?: string
  shortFingerprint: string
  fingerprintVersion?: 'cpu-v1'
  hostName?: string
  platform?: string
  arch?: string
  appVersion: string
  available?: boolean
  reason?: string
}

const downloadTaskSnapshots = new Map<string, DownloadTaskSnapshot>()
const PYTHON_RUNTIME_TRACKING_KEY = 'python_runtime'
let pythonRuntimeInstallPromise: Promise<{ success: boolean; installed: boolean; error?: string }> | null = null
const VERBOSE_MAIN_LOGS = process.env.VSM_VERBOSE_MAIN === '1'
const LICENSE_PRODUCT_NAME = 'VideoSyncMaster'
const LICENSE_CACHE_FILE = 'active-license.cache.json'
const LICENSE_PUBLIC_KEY_FILE = 'public-key.pem'
const TRUSTED_LICENSE_PUBLIC_KEY_FINGERPRINT = '04B0BFB1FE9B01E0'
const ACTIVATION_CODE_MAGIC = 'VSM2'
const ACTIVATION_CODE_VERSION = 2
const ACTIVATION_CODE_NOTE = 'activation-code-v2'
const BASE32_CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SHORT_DEVICE_CODE_VERSION = 'cpu-short-v1'
const SHORT_DEVICE_CODE_LENGTH = 20
const PLAN_CODE_BY_ID: Record<string, number> = {
  'starter-monthly': 1,
  'starter-quarterly': 2,
  'starter-yearly': 3
}
const PLAN_ID_BY_CODE = new Map<number, string>(Object.entries(PLAN_CODE_BY_ID).map(([planId, code]) => [code, planId]))
const LICENSE_PLANS: LicensePlanDefinition[] = [
  {
    id: 'starter-monthly',
    name: '个人月套餐',
    cycle: 'monthly',
    priceCny: 15,
    priceLabel: '15 元 / 月',
    seats: 1,
    description: '适合轻量级日常制作。',
    features: ['单设备授权', '本地识别/翻译/配音', '字幕与成片导出', '标准更新支持']
  },
  {
    id: 'starter-quarterly',
    name: '个人季套餐',
    cycle: 'quarterly',
    priceCny: 39,
    priceLabel: '39 元 / 季',
    seats: 1,
    description: '适合阶段性交付与连续使用。',
    features: ['单设备授权', '批量任务能力', '模型目录管理', '标准更新支持']
  },
  {
    id: 'starter-yearly',
    name: '个人年套餐',
    cycle: 'yearly',
    priceCny: 129,
    priceLabel: '129 元 / 年',
    seats: 1,
    description: '适合长期稳定生产使用。',
    features: ['单设备授权', '批量生产能力', '年度更新支持', '优先工单响应']
  }
]

const LICENSE_PROTECTED_BACKEND_ACTIONS = new Set([
  'test_asr',
  'translate_text',
  'test_tts',
  'merge_video',
  'dub_video',
  'generate_single_tts',
  'generate_batch_tts',
  'prepare_reference_audio'
])
const LICENSE_TICKET_SECRET_ENV = 'VSM_LICENSE_TICKET_SECRET'
const LICENSE_TICKET_TTL_MS = 90 * 1000
const backendLicenseTicketSecret = randomBytes(32).toString('hex')

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

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    logger: 'electron.main',
    domain: fields.domain,
    log_type: logType,
    message: String(message || ''),
    action: fields.action || '-',
    event: String(fields.event || ''),
    stage: String(fields.stage || ''),
    code: String(fields.code || ''),
    detail: String(fields.detail || '')
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
// Keep recoverable sessions for a while so interrupted jobs can resume after app restart.
const CACHE_RETENTION_DAYS = 3
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

  const huggingFaceFetchMatch = message.match(/Fetching\s+(\d+)\s+files:\s+(\d{1,3})%\|[^\r\n]*?(\d+)\/(\d+)/i)
  if (huggingFaceFetchMatch) {
    const totalFiles = Number(huggingFaceFetchMatch[1])
    const percent = Number(huggingFaceFetchMatch[2])
    const completedFiles = Number(huggingFaceFetchMatch[3])
    return {
      percent,
      phase: 'downloading' as const,
      message: `Hugging Face 官方下载中 ${percent}%（${completedFiles}/${totalFiles} 个文件）`
    }
  }

  const huggingFaceFetchStartedMatch = message.match(/Fetching\s+(\d+)\s+files:\s+0%\|/i)
  if (huggingFaceFetchStartedMatch) {
    const totalFiles = Number(huggingFaceFetchStartedMatch[1])
    return {
      percent: 1,
      phase: 'downloading' as const,
      message: `Hugging Face 官方下载已开始（0/${totalFiles} 个文件）`
    }
  }

  return null
}

function emitModelDownloadProgress(
  sender: Electron.WebContents,
  key: string,
  progress: {
    percent?: number
    phase?: DownloadProgressPhase
    message?: string
  }
) {
  const snapshot: DownloadTaskSnapshot = {
    key,
    active: progress.phase !== 'completed' && progress.phase !== 'failed' && progress.phase !== 'canceled',
    percent: progress.percent,
    phase: progress.phase,
    message: progress.message
  }
  downloadTaskSnapshots.set(key, snapshot)
  sender.send('model-download-progress', snapshot)
}

function broadcastModelDownloadProgress(
  key: string,
  progress: {
    percent?: number
    phase?: DownloadProgressPhase
    message?: string
  }
) {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length === 0) {
    const snapshot: DownloadTaskSnapshot = {
      key,
      active: progress.phase !== 'completed' && progress.phase !== 'failed' && progress.phase !== 'canceled',
      percent: progress.percent,
      phase: progress.phase,
      message: progress.message
    }
    downloadTaskSnapshots.set(key, snapshot)
    return
  }

  for (const browserWindow of windows) {
    if (browserWindow.isDestroyed()) continue
    emitModelDownloadProgress(browserWindow.webContents, key, progress)
  }
}

function markDownloadTaskStarted(key: string, message: string, phase: DownloadProgressPhase = 'preparing') {
  downloadTaskSnapshots.set(key, {
    key,
    active: true,
    percent: 0,
    phase,
    message
  })
}

function getDownloadTaskSnapshots() {
  return Array.from(downloadTaskSnapshots.values())
}

async function resolveGitHubReleaseAssetDownloadUrl(spec: GitHubReleaseAssetSpec) {
  const apiUrl = `https://api.github.com/repos/${spec.owner}/${spec.repo}/releases/tags/${encodeURIComponent(spec.tag)}`
  const response = await fetch(apiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'VideoSyncMaster'
    }
  })
  if (!response.ok) {
    throw new Error(`GitHub release API returned ${response.status}`)
  }

  const payload = await response.json() as {
    assets?: Array<{ name?: string; browser_download_url?: string }>
  }
  const matcher = new RegExp(spec.assetPattern)
  const matchedAsset = (payload.assets || []).find((asset) => matcher.test(asset.name || '') && asset.browser_download_url)
  if (!matchedAsset?.browser_download_url) {
    throw new Error(`No release asset matched pattern: ${spec.assetPattern}`)
  }
  return matchedAsset.browser_download_url
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

function getFasterWhisperRuntimeSearchRoots(projectRoot: string, modelsRoot = resolveModelsRoot(projectRoot).modelsRoot) {
  const candidates = [
    path.join(modelsRoot, 'faster_whisper_runtime'),
    path.join(getStorageRoot(projectRoot), 'models', 'faster_whisper_runtime'),
    path.join(projectRoot, 'models', 'faster_whisper_runtime'),
    path.join(projectRoot, 'resources', 'media_tools', 'faster_whisper'),
    path.join(projectRoot, 'resources', 'media_tools'),
    path.join(projectRoot, 'resources'),
    projectRoot,
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
  const projectRoot = getProjectRoot()
  const storageRoot = getStorageRoot(projectRoot)
  const { modelsRoot } = resolveModelsRoot(projectRoot)
  const { runtimeRoot } = resolveRuntimeRoot(projectRoot)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    SETUPTOOLS_USE_DISTUTILS: 'stdlib',
    HF_HUB_DISABLE_XET: '1',
    NUMBA_DISABLE_INTEL_SVML: '1',
    NUMBA_CPU_NAME: 'generic',
    VSM_STORAGE_ROOT: storageRoot,
    VSM_MODELS_ROOT: modelsRoot,
    VSM_RUNTIME_ROOT: runtimeRoot
  }

  try {
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

function getLocalAppDataRoot() {
  if (process.env.LOCALAPPDATA) {
    return process.env.LOCALAPPDATA
  }
  return path.join(app.getPath('home'), 'AppData', 'Local')
}

function getPackagedStorageRoot() {
  return path.join(getLocalAppDataRoot(), app.getName())
}

function getDefaultUserOutputRoot() {
  const preferredBase = app.getPath('videos') || app.getPath('documents')
  return path.join(preferredBase, app.getName())
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
  if (app.isPackaged) {
    return getPackagedStorageRoot()
  }
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
  if (app.isPackaged) {
    return getDefaultUserOutputRoot()
  }
  return path.join(getStorageRoot(projectRoot), 'output')
}

function getOutputCacheRoot(projectRoot = getProjectRoot()) {
  return path.join(getOutputRoot(projectRoot), '.videosync-cache')
}

function getOutputSessionCacheRoot(projectRoot = getProjectRoot()) {
  return path.join(getOutputCacheRoot(projectRoot), 'sessions')
}

function getSessionCacheRoot(projectRoot = getProjectRoot()) {
  return path.join(getCacheRoot(projectRoot), 'sessions')
}

function getManagedRuntimeRoot(projectRoot = getProjectRoot()) {
  return path.join(getStorageRoot(projectRoot), 'runtime')
}

function getManagedModelsRoot(projectRoot = getProjectRoot()) {
  return path.join(getStorageRoot(projectRoot), 'models')
}

function getModelRootSettingsPath(projectRoot = getProjectRoot()) {
  return path.join(getStorageRoot(projectRoot), 'config', 'model-root-settings.json')
}

function getRuntimeRootSettingsPath(projectRoot = getProjectRoot()) {
  return path.join(getStorageRoot(projectRoot), 'config', 'runtime-root-settings.json')
}

function readModelRootSettings(projectRoot = getProjectRoot()): ModelRootSettingsRecord {
  const settingsPath = getModelRootSettingsPath(projectRoot)
  if (!fs.existsSync(settingsPath)) {
    return {}
  }

  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw) as ModelRootSettingsRecord
    return typeof parsed?.customModelsRoot === 'string'
      ? { customModelsRoot: parsed.customModelsRoot }
      : {}
  } catch (error) {
    logMainWarn('读取模型目录配置失败，回退默认目录', {
      domain: 'model.lifecycle',
      action: 'readModelRootSettings',
      detail: error instanceof Error ? error.message : String(error)
    })
    return {}
  }
}

function writeModelRootSettings(settings: ModelRootSettingsRecord, projectRoot = getProjectRoot()) {
  const settingsPath = getModelRootSettingsPath(projectRoot)
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
}

function readRuntimeRootSettings(projectRoot = getProjectRoot()): RuntimeRootSettingsRecord {
  const settingsPath = getRuntimeRootSettingsPath(projectRoot)
  if (!fs.existsSync(settingsPath)) {
    return {}
  }

  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw) as RuntimeRootSettingsRecord
    return typeof parsed?.customRuntimeRoot === 'string'
      ? { customRuntimeRoot: parsed.customRuntimeRoot }
      : {}
  } catch (error) {
    logMainWarn('读取运行环境目录配置失败，回退默认目录', {
      domain: 'runtime.env',
      action: 'readRuntimeRootSettings',
      detail: error instanceof Error ? error.message : String(error)
    })
    return {}
  }
}

function writeRuntimeRootSettings(settings: RuntimeRootSettingsRecord, projectRoot = getProjectRoot()) {
  const settingsPath = getRuntimeRootSettingsPath(projectRoot)
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
}

function normalizeConfiguredModelsRoot(candidate: string | null | undefined) {
  const normalized = String(candidate || '').trim()
  if (!normalized) {
    return null
  }
  return path.resolve(normalized)
}

function normalizeConfiguredRuntimeRoot(candidate: string | null | undefined) {
  const normalized = String(candidate || '').trim()
  if (!normalized) {
    return null
  }
  return path.resolve(normalized)
}

function isPathInside(parentPath: string, childPath: string) {
  const parent = path.resolve(parentPath)
  const child = path.resolve(childPath)
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isProtectedInstallLocation(targetPath: string) {
  if (process.platform !== 'win32') {
    return false
  }

  const normalizedTarget = path.resolve(targetPath).toLowerCase()
  const protectedRoots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432']
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value).toLowerCase())

  return protectedRoots.some((root) => isPathInside(root, normalizedTarget))
}

function getDefaultModelsRoot(projectRoot = getProjectRoot()) {
  if (app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'models')
  }

  const repoLikeRoot = path.join(projectRoot, 'models')
  if (app.isPackaged && isProtectedInstallLocation(repoLikeRoot)) {
    return getManagedModelsRoot(projectRoot)
  }
  return repoLikeRoot
}

function resolveModelsRoot(projectRoot = getProjectRoot()): ResolvedModelsRootInfo {
  const managedModelsRoot = getManagedModelsRoot(projectRoot)
  const defaultModelsRoot = getDefaultModelsRoot(projectRoot)
  const configuredModelsRoot = normalizeConfiguredModelsRoot(
    readModelRootSettings(projectRoot).customModelsRoot
  )
  const modelsRoot = configuredModelsRoot || defaultModelsRoot

  return {
    projectRoot,
    modelsRoot,
    defaultModelsRoot,
    managedModelsRoot,
    configuredModelsRoot,
    usingCustomRoot: Boolean(configuredModelsRoot),
    protectedDefaultRoot: isProtectedInstallLocation(defaultModelsRoot)
  }
}

function getDefaultRuntimeRoot(projectRoot = getProjectRoot()) {
  if (app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'runtime')
  }

  const repoLikeRoot = path.join(projectRoot, 'runtime')
  if (app.isPackaged && isProtectedInstallLocation(repoLikeRoot)) {
    return getManagedRuntimeRoot(projectRoot)
  }
  return repoLikeRoot
}

function resolveRuntimeRoot(projectRoot = getProjectRoot()): ResolvedRuntimeRootInfo {
  const managedRuntimeRoot = getManagedRuntimeRoot(projectRoot)
  const defaultRuntimeRoot = getDefaultRuntimeRoot(projectRoot)
  const configuredRuntimeRoot = normalizeConfiguredRuntimeRoot(
    readRuntimeRootSettings(projectRoot).customRuntimeRoot
  )
  const runtimeRoot = configuredRuntimeRoot || defaultRuntimeRoot

  return {
    projectRoot,
    runtimeRoot,
    defaultRuntimeRoot,
    managedRuntimeRoot,
    configuredRuntimeRoot,
    usingCustomRoot: Boolean(configuredRuntimeRoot),
    protectedDefaultRoot: isProtectedInstallLocation(defaultRuntimeRoot)
  }
}

function movePathSync(sourcePath: string, targetPath: string) {
  if (!fs.existsSync(sourcePath)) {
    return
  }

  if (fs.existsSync(targetPath)) {
    const sourceStat = fs.statSync(sourcePath)
    const targetStat = fs.statSync(targetPath)
    if (sourceStat.isDirectory() && targetStat.isDirectory()) {
      for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
        movePathSync(path.join(sourcePath, entry.name), path.join(targetPath, entry.name))
      }
      const remaining = fs.readdirSync(sourcePath)
      if (remaining.length === 0) {
        fs.rmSync(sourcePath, { recursive: true, force: true })
      }
      return
    }
    throw new Error(`目标已存在：${targetPath}`)
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  try {
    fs.renameSync(sourcePath, targetPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== 'EXDEV') {
      throw error
    }
    fs.cpSync(sourcePath, targetPath, { recursive: true })
    fs.rmSync(sourcePath, { recursive: true, force: true })
  }
}

function migrateModelsRootContents(sourceRoot: string, targetRoot: string) {
  const fromRoot = path.resolve(sourceRoot)
  const toRoot = path.resolve(targetRoot)

  if (fromRoot === toRoot || !fs.existsSync(fromRoot)) {
    return { movedEntries: 0 }
  }

  fs.mkdirSync(toRoot, { recursive: true })
  let movedEntries = 0
  for (const entry of fs.readdirSync(fromRoot, { withFileTypes: true })) {
    movePathSync(path.join(fromRoot, entry.name), path.join(toRoot, entry.name))
    movedEntries += 1
  }
  return { movedEntries }
}

function getRuntimeOverlayRoot(overlayName: string, projectRoot = getProjectRoot()) {
  const { runtimeRoot } = resolveRuntimeRoot(projectRoot)
  return resolveFirstExistingPath([
    path.join(runtimeRoot, 'overlays', overlayName),
    path.join(getManagedRuntimeRoot(projectRoot), 'overlays', overlayName),
    path.join(projectRoot, 'runtime', 'overlays', overlayName)
  ])
}

function getPythonRoot(projectRoot = getProjectRoot()) {
  const { runtimeRoot } = resolveRuntimeRoot(projectRoot)
  return resolveFirstExistingPath([
    path.join(runtimeRoot, 'python'),
    path.join(getManagedRuntimeRoot(projectRoot), 'python'),
    path.join(projectRoot, 'runtime', 'python'),
    path.join(projectRoot, 'python')
  ])
}

function getManagedPythonLocationHint(projectRoot = getProjectRoot()) {
  return Array.from(new Set([
    path.join(resolveRuntimeRoot(projectRoot).runtimeRoot, 'python'),
    path.join(getManagedRuntimeRoot(projectRoot), 'python'),
    getPythonLocationHint(projectRoot)
  ])).join(' 或 ')
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

const OFFICIAL_PYTHON_VERSION = '3.11.9'
const OFFICIAL_PYTHON_ARCHIVE_NAME = `python-${OFFICIAL_PYTHON_VERSION}-embed-amd64.zip`
const OFFICIAL_PYTHON_DOWNLOAD_URL = `https://www.python.org/ftp/python/${OFFICIAL_PYTHON_VERSION}/${OFFICIAL_PYTHON_ARCHIVE_NAME}`
const OFFICIAL_GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py'
const OFFICIAL_GET_PIP_FILE_NAME = 'get-pip.py'
const OFFICIAL_PYTORCH_CUDA_INDEX_URL = 'https://download.pytorch.org/whl/cu128'
const OFFICIAL_PYTORCH_CUDA_VARIANT = 'cu128'
const MANAGED_RUNTIME_STATE_FILE = '.videosync-runtime-bootstrap.json'
const MANAGED_RUNTIME_PATCH_SIGNATURE = 'triton-3.1.0|flash_attn-2.8.1'
const MANAGED_RUNTIME_PATCH_NAMES = [
  'triton',
  'triton-3.1.0.dist-info',
  'flash_attn',
  'flash_attn-2.8.1.dist-info',
  'flash_attn_2_cuda.cp311-win_amd64.pyd'
]

function getManagedRuntimeStatePath(projectRoot = getProjectRoot()) {
  return path.join(resolveRuntimeRoot(projectRoot).runtimeRoot, MANAGED_RUNTIME_STATE_FILE)
}

function getManagedRuntimePythonRoot(projectRoot = getProjectRoot()) {
  return path.join(resolveRuntimeRoot(projectRoot).runtimeRoot, 'python')
}

function getManagedRuntimePythonExe(projectRoot = getProjectRoot()) {
  return path.join(getManagedRuntimePythonRoot(projectRoot), 'python.exe')
}

function getRequirementsHash(projectRoot = getProjectRoot()) {
  const requirementsPath = path.join(projectRoot, 'requirements.txt')
  if (!fs.existsSync(requirementsPath)) {
    throw new Error(`requirements.txt 不存在：${requirementsPath}`)
  }
  return sha256File(requirementsPath)
}

function readPinnedRequirementVersion(projectRoot: string, packageName: string) {
  const requirementsPath = path.join(projectRoot, 'requirements.txt')
  const raw = fs.readFileSync(requirementsPath, 'utf-8')
  const normalizedName = packageName.trim().toLowerCase()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const packageMatch = trimmed.match(/^([A-Za-z0-9_.-]+)==([^\s;#]+)$/)
    if (!packageMatch) continue
    if (packageMatch[1].trim().toLowerCase() === normalizedName) {
      return packageMatch[2].trim()
    }
  }
  throw new Error(`requirements.txt 中缺少固定版本依赖：${packageName}`)
}

function readManagedRuntimeState(projectRoot = getProjectRoot()) {
  const statePath = getManagedRuntimeStatePath(projectRoot)
  if (!fs.existsSync(statePath)) {
    return null
  }

  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
      schemaVersion?: number
      pythonVersion?: string
      requirementsHash?: string
      patchSignature?: string
      torchVariant?: string
      installedAt?: string
    }
  } catch {
    return null
  }
}

function isManagedTorchCudaBuildReady(projectRoot = getProjectRoot()) {
  const versionPyPath = path.join(getManagedRuntimePythonRoot(projectRoot), 'Lib', 'site-packages', 'torch', 'version.py')
  if (!fs.existsSync(versionPyPath)) {
    return false
  }
  try {
    const raw = fs.readFileSync(versionPyPath, 'utf-8')
    return raw.includes(`__version__ = '2.7.1+${OFFICIAL_PYTORCH_CUDA_VARIANT}'`)
      || raw.includes(`cuda: Optional[str] = '12.8'`)
  } catch {
    return false
  }
}

function isManagedPythonRuntimeReady(projectRoot = getProjectRoot()) {
  const pythonExe = getManagedRuntimePythonExe(projectRoot)
  if (!fs.existsSync(pythonExe)) {
    return false
  }

  const state = readManagedRuntimeState(projectRoot)
  if (!state) {
    return false
  }

  try {
    return state.pythonVersion === OFFICIAL_PYTHON_VERSION
      && state.requirementsHash === getRequirementsHash(projectRoot)
      && state.patchSignature === MANAGED_RUNTIME_PATCH_SIGNATURE
      && state.torchVariant === OFFICIAL_PYTORCH_CUDA_VARIANT
      && isManagedTorchCudaBuildReady(projectRoot)
  } catch {
    return false
  }
}

function getRuntimeDownloadInfo() {
  return {
    success: true,
    bundleFileName: OFFICIAL_PYTHON_ARCHIVE_NAME,
    downloadUrl: OFFICIAL_PYTHON_DOWNLOAD_URL,
    downloadPageUrl: OFFICIAL_PYTHON_DOWNLOAD_URL
  }
}

function getSevenZipExecutablePath(projectRoot = getProjectRoot()) {
  const candidates = app.isPackaged
    ? [
        path.join(projectRoot, 'resources', 'bin', '7za.exe'),
        path.join(process.resourcesPath, 'bin', '7za.exe'),
        path7za
      ]
    : [path7za]

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(`找不到 7za.exe：${candidates.join(' | ')}`)
}

function buildRuntimeManualDownloadMessage(reason: string, projectRoot = getProjectRoot()) {
  const info = getRuntimeDownloadInfo()
  return [
    `Python 运行时自动安装失败：${reason}`,
    '',
    `可前往官方下载页面：${info.downloadPageUrl}`,
    `Python 版本：${OFFICIAL_PYTHON_VERSION} x64`,
    `运行时目标目录：${getManagedRuntimePythonRoot(projectRoot)}`,
    '请优先重新点击“修复运行环境”。若仍失败，再使用“前往下载”获取官方安装包。'
  ].join('\n')
}

function sha256File(filePath: string) {
  const hash = createHash('sha256')
  const data = fs.readFileSync(filePath)
  hash.update(data)
  return hash.digest('hex')
}

async function downloadRuntimeBundle(downloadUrl: string, destinationPath: string, onProgress?: (percent: number, message: string) => void) {
  if (/^file:\/\//i.test(downloadUrl)) {
    const sourcePath = fileURLToPath(downloadUrl)
    fs.copyFileSync(sourcePath, destinationPath)
    onProgress?.(100, '运行时下载完成')
    return
  }

  if (/^[a-zA-Z]:\\/.test(downloadUrl) || downloadUrl.startsWith('\\\\')) {
    fs.copyFileSync(downloadUrl, destinationPath)
    onProgress?.(100, '运行时下载完成')
    return
  }

  const response = await fetch(downloadUrl)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download runtime bundle: HTTP ${response.status}`)
  }

  const totalBytes = Number(response.headers.get('content-length') || 0)
  let receivedBytes = 0
  let lastPercent = -1
  const reader = response.body.getReader()
  const handle = fs.openSync(destinationPath, 'w')

  try {
    let done = false
    while (!done) {
      const readResult = await reader.read()
      done = readResult.done
      if (done) break
      const { value } = readResult
      if (!value) continue
      const chunk = Buffer.from(value)
      fs.writeSync(handle, chunk)
      receivedBytes += chunk.length
      if (totalBytes > 0) {
        const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
        if (percent !== lastPercent) {
          lastPercent = percent
          onProgress?.(percent, `运行时下载中 ${percent}%`)
        }
      }
    }
  } finally {
    fs.closeSync(handle)
  }

  if (totalBytes > 0 && receivedBytes !== totalBytes) {
    throw new Error(`Runtime bundle download incomplete: expected ${totalBytes} bytes, got ${receivedBytes}`)
  }

  onProgress?.(100, '运行时下载完成')
}

async function extractRuntimeBundle(archivePath: string, destinationRoot: string) {
  const sevenZipPath = getSevenZipExecutablePath()
  await new Promise<void>((resolve, reject) => {
    execFile(sevenZipPath, ['x', archivePath, `-o${destinationRoot}`, '-y'], (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function ensureEmbeddedPythonSiteEnabled(pythonRoot: string) {
  const pthPath = path.join(pythonRoot, 'python311._pth')
  if (!fs.existsSync(pthPath)) {
    return
  }

  const requiredEntries = ['python311.zip', '.', 'Lib', 'Lib\\site-packages', 'import site']
  const existingLines = fs.readFileSync(pthPath, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const preservedLines = existingLines.filter((line) => {
    const normalized = line.replace(/\//g, '\\')
    return normalized !== 'Lib'
      && normalized !== 'Lib\\site-packages'
      && !/^#?\s*import site\s*$/i.test(line)
  })

  const finalLines = [
    ...requiredEntries.filter((entry) => preservedLines.every((line) => line.replace(/\//g, '\\') !== entry)),
    ...preservedLines
  ]

  fs.writeFileSync(pthPath, `${finalLines.join('\n').trimEnd()}\n`, 'utf-8')
}

function getBootstrapPythonEnv(projectRoot = getProjectRoot()): NodeJS.ProcessEnv {
  const { modelsRoot } = resolveModelsRoot(projectRoot)
  const { runtimeRoot } = resolveRuntimeRoot(projectRoot)
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    SETUPTOOLS_USE_DISTUTILS: 'stdlib',
    VSM_STORAGE_ROOT: getStorageRoot(projectRoot),
    VSM_MODELS_ROOT: modelsRoot,
    VSM_RUNTIME_ROOT: runtimeRoot
  }
}

function getPackagedRuntimePatchRoot(projectRoot = getProjectRoot()) {
  return path.join(projectRoot, 'resources', 'runtime-patches', 'site-packages')
}

function createBootstrapRequirementsFile(projectRoot: string, cacheRoot: string) {
  const requirementsPath = path.join(projectRoot, 'requirements.txt')
  const raw = fs.readFileSync(requirementsPath, 'utf-8')
  const skippedPackages = new Set(['triton', 'torch', 'torchvision', 'torchaudio'])
  const filtered = raw
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return true
      const normalized = trimmed.toLowerCase()
      if (normalized === 'triton') return false
      const packageMatch = trimmed.match(/^([A-Za-z0-9_.-]+)/)
      if (!packageMatch) return true
      return !skippedPackages.has(packageMatch[1].trim().toLowerCase())
    })
    .join('\n')
  const bootstrapRequirementsPath = path.join(cacheRoot, 'requirements.bootstrap.txt')
  fs.writeFileSync(bootstrapRequirementsPath, `${filtered.trimEnd()}\n`, 'utf-8')
  return bootstrapRequirementsPath
}

async function cleanupExpiredRuntimeBootstrapCache(cacheRoot: string) {
  const now = Date.now()
  const entries = await fs.promises.readdir(cacheRoot, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    const entryPath = path.join(cacheRoot, entry.name)
    const stat = await fs.promises.stat(entryPath).catch(() => null)
    if (!stat) continue

    const lastTouched = Math.max(stat.mtimeMs || 0, stat.ctimeMs || 0, stat.birthtimeMs || 0)
    if (now - lastTouched <= CACHE_RETENTION_MS) {
      continue
    }

    await fs.promises.rm(entryPath, { recursive: true, force: true }).catch(() => undefined)
  }

  const remainingEntries = await fs.promises.readdir(cacheRoot).catch(() => [])
  if (remainingEntries.length === 0) {
    await fs.promises.rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function cleanupRuntimeBootstrapCache(cacheRoot: string) {
  await fs.promises.rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined)
}

function applyPackagedRuntimePatches(projectRoot: string, pythonRoot: string) {
  const patchRoot = getPackagedRuntimePatchRoot(projectRoot)
  if (!fs.existsSync(patchRoot)) {
    throw new Error(`未找到运行时补丁目录：${patchRoot}`)
  }

  const sitePackagesRoot = path.join(pythonRoot, 'Lib', 'site-packages')
  fs.mkdirSync(sitePackagesRoot, { recursive: true })

  for (const patchName of MANAGED_RUNTIME_PATCH_NAMES) {
    const sourcePath = path.join(patchRoot, patchName)
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`运行时补丁缺失：${sourcePath}`)
    }

    const targetPath = path.join(sitePackagesRoot, patchName)
    fs.rmSync(targetPath, { recursive: true, force: true })
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true })
  }
}

async function runProcessWithLogs(
  executable: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    progressMessage?: string
    percent?: number
  } = {}
) {
  if (options.progressMessage) {
    broadcastModelDownloadProgress(PYTHON_RUNTIME_TRACKING_KEY, {
      phase: 'installing',
      percent: options.percent,
      message: options.progressMessage
    })
  }

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += decodeProcessChunk(data)
    })
    proc.stderr.on('data', (data) => {
      stderr += decodeProcessChunk(data)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(`${executable} ${args.join(' ')} failed with code ${code}\n${stderr || stdout}`))
    })
  })
}

async function installManagedPythonRuntime() {
  const projectRoot = getProjectRoot()
  const runtimeRoot = resolveRuntimeRoot(projectRoot).runtimeRoot
  if (isManagedPythonRuntimeReady(projectRoot)) {
    return { success: true, installed: false }
  }

  const cacheRoot = path.join(getCacheRoot(projectRoot), 'downloads', 'runtime-bootstrap')
  const archivePath = path.join(cacheRoot, OFFICIAL_PYTHON_ARCHIVE_NAME)
  const getPipPath = path.join(cacheRoot, OFFICIAL_GET_PIP_FILE_NAME)
  const stagingRoot = `${runtimeRoot}.staging`
  const backupRoot = `${runtimeRoot}.backup`
  const stagingPythonRoot = path.join(stagingRoot, 'python')
  const bootstrapEnv = getBootstrapPythonEnv(projectRoot)
  let installSucceeded = false

  await cleanupExpiredRuntimeBootstrapCache(cacheRoot)
  fs.mkdirSync(cacheRoot, { recursive: true })
  if (fs.existsSync(stagingRoot)) {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
  }
  fs.mkdirSync(stagingPythonRoot, { recursive: true })

  broadcastModelDownloadProgress(PYTHON_RUNTIME_TRACKING_KEY, {
    percent: 0,
    phase: 'preparing',
    message: '准备安装官方 Python 运行时'
  })

  try {
    await downloadRuntimeBundle(OFFICIAL_PYTHON_DOWNLOAD_URL, archivePath, (percent, message) => {
      broadcastModelDownloadProgress(PYTHON_RUNTIME_TRACKING_KEY, {
        percent: Math.min(35, Math.round(percent * 0.35)),
        phase: 'downloading',
        message: message.replace('运行时', '官方 Python')
      })
    })

    broadcastModelDownloadProgress(PYTHON_RUNTIME_TRACKING_KEY, {
      percent: 40,
      phase: 'extracting',
      message: '正在解压官方 Python 运行时'
    })
    await extractRuntimeBundle(archivePath, stagingPythonRoot)
    ensureEmbeddedPythonSiteEnabled(stagingPythonRoot)

    if (!fs.existsSync(path.join(stagingPythonRoot, 'python.exe'))) {
      throw new Error(`解压后的 Python 目录缺少 python.exe：${stagingPythonRoot}`)
    }

    await downloadRuntimeBundle(OFFICIAL_GET_PIP_URL, getPipPath, (percent, message) => {
      broadcastModelDownloadProgress(PYTHON_RUNTIME_TRACKING_KEY, {
        percent: 40 + Math.min(10, Math.round(percent * 0.1)),
        phase: 'downloading',
        message: message.replace('运行时', 'pip 安装器')
      })
    })

    const stagingPythonExe = path.join(stagingPythonRoot, 'python.exe')
    const bootstrapRequirementsPath = createBootstrapRequirementsFile(projectRoot, cacheRoot)

    await runProcessWithLogs(stagingPythonExe, [getPipPath], {
      env: bootstrapEnv,
      progressMessage: '正在安装 pip',
      percent: 55
    })

    await runProcessWithLogs(stagingPythonExe, ['-c', 'import pip; print(pip.__version__)'], {
      env: bootstrapEnv,
      progressMessage: '正在校验 pip 运行环境',
      percent: 60
    })

    await runProcessWithLogs(stagingPythonExe, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], {
      env: bootstrapEnv,
      progressMessage: '正在升级 pip 基础工具',
      percent: 65
    })

    const torchVersion = readPinnedRequirementVersion(projectRoot, 'torch')
    const torchvisionVersion = readPinnedRequirementVersion(projectRoot, 'torchvision')
    const torchaudioVersion = readPinnedRequirementVersion(projectRoot, 'torchaudio')

    await runProcessWithLogs(stagingPythonExe, [
      '-m', 'pip', 'install',
      '--index-url', OFFICIAL_PYTORCH_CUDA_INDEX_URL,
      `torch==${torchVersion}`,
      `torchvision==${torchvisionVersion}`,
      `torchaudio==${torchaudioVersion}`
    ], {
      env: bootstrapEnv,
      progressMessage: '正在安装 CUDA 版 PyTorch 运行时',
      percent: 72
    })

    await runProcessWithLogs(stagingPythonExe, ['-c', 'import torch; assert torch.cuda.is_available(), "CUDA unavailable in managed runtime"; print(torch.__version__); print(torch.version.cuda or "none")'], {
      env: bootstrapEnv,
      progressMessage: '正在校验 CUDA 版 PyTorch 运行时',
      percent: 75
    })

    await runProcessWithLogs(stagingPythonExe, ['-m', 'pip', 'install', '-r', bootstrapRequirementsPath], {
      env: bootstrapEnv,
      progressMessage: '正在从官方依赖源安装运行时依赖',
      percent: 78
    })

    broadcastModelDownloadProgress(PYTHON_RUNTIME_TRACKING_KEY, {
      percent: 92,
      phase: 'installing',
      message: '正在应用本地运行时补丁'
    })
    applyPackagedRuntimePatches(projectRoot, stagingPythonRoot)

    if (fs.existsSync(backupRoot)) {
      fs.rmSync(backupRoot, { recursive: true, force: true })
    }
    if (fs.existsSync(runtimeRoot)) {
      fs.renameSync(runtimeRoot, backupRoot)
    }
    fs.renameSync(stagingRoot, runtimeRoot)
    if (fs.existsSync(backupRoot)) {
      fs.rmSync(backupRoot, { recursive: true, force: true })
    }

    fs.writeFileSync(
      getManagedRuntimeStatePath(projectRoot),
      JSON.stringify({
        schemaVersion: 1,
        pythonVersion: OFFICIAL_PYTHON_VERSION,
        requirementsHash: getRequirementsHash(projectRoot),
        patchSignature: MANAGED_RUNTIME_PATCH_SIGNATURE,
        torchVariant: OFFICIAL_PYTORCH_CUDA_VARIANT,
        installedAt: new Date().toISOString()
      }, null, 2),
      'utf-8'
    )

    installSucceeded = true
    broadcastModelDownloadProgress(PYTHON_RUNTIME_TRACKING_KEY, {
      percent: 100,
      phase: 'completed',
      message: 'Python 运行时已安装完成'
    })

    return { success: true, installed: true }
  } finally {
    if (installSucceeded) {
      await cleanupRuntimeBootstrapCache(cacheRoot)
    }
  }
}

async function ensurePackagedPythonRuntime() {
  if (!app.isPackaged) {
    return { success: true, installed: false }
  }

  if (pythonRuntimeInstallPromise) {
    return await pythonRuntimeInstallPromise
  }

  pythonRuntimeInstallPromise = installManagedPythonRuntime()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      broadcastModelDownloadProgress(PYTHON_RUNTIME_TRACKING_KEY, {
        phase: 'failed',
        message: buildRuntimeManualDownloadMessage(message)
      })
      return { success: false, installed: false, error: buildRuntimeManualDownloadMessage(message) }
    })
    .finally(() => {
      pythonRuntimeInstallPromise = null
    })

  return await pythonRuntimeInstallPromise
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
      error: `找不到 Python 解释器。请确认运行时目录存在于 ${getManagedPythonLocationHint(projectRoot)}`
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
  const electronDataDir = path.join(getStorageRoot(projectRoot), 'electron')
  const userDataDir = path.join(electronDataDir, 'user-data')
  const sessionDataDir = path.join(electronDataDir, 'session-data')
  const cacheDir = path.join(electronDataDir, 'cache')
  const gpuCacheDir = path.join(cacheDir, 'GPUCache')

  for (const dir of [electronDataDir, userDataDir, sessionDataDir, cacheDir, gpuCacheDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  const legacySessionEntries = fs.existsSync(cacheDir)
    ? fs.readdirSync(cacheDir, { withFileTypes: true })
    : []
  const cacheOnlyNames = new Set([
    'Cache',
    'Code Cache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'GPUCache',
    'Shared Dictionary'
  ])

  for (const entry of legacySessionEntries) {
    if (cacheOnlyNames.has(entry.name)) {
      continue
    }
    const fromPath = path.join(cacheDir, entry.name)
    const toPath = path.join(sessionDataDir, entry.name)
    if (fs.existsSync(toPath)) {
      continue
    }
    try {
      fs.renameSync(fromPath, toPath)
    } catch (error) {
      logMainWarn('迁移旧版 Electron 会话数据失败', {
        domain: 'bootstrap',
        action: 'ensureElectronStoragePaths',
        detail: `${fromPath} -> ${toPath}\n${error instanceof Error ? error.message : String(error)}`
      })
    }
  }

  app.setPath('userData', userDataDir)
  app.setPath('sessionData', sessionDataDir)
  app.setPath('cache', cacheDir)
  app.commandLine.appendSwitch('disk-cache-dir', cacheDir)
  app.commandLine.appendSwitch('user-data-dir', userDataDir)
}

function getDefaultOutputDir() {
  return getOutputRoot()
}

ensureElectronStoragePaths()

async function migrateLegacySessionCaches(projectRoot = getProjectRoot()) {
  const legacyRoot = getOutputSessionCacheRoot(projectRoot)
  const currentRoot = getSessionCacheRoot(projectRoot)

  if (!fs.existsSync(legacyRoot)) {
    return
  }

  await fs.promises.mkdir(currentRoot, { recursive: true })
  const typeEntries = await fs.promises.readdir(legacyRoot, { withFileTypes: true }).catch(() => [])

  for (const typeEntry of typeEntries) {
    if (!typeEntry.isDirectory()) {
      continue
    }

    const sourceTypeDir = path.join(legacyRoot, typeEntry.name)
    const targetTypeDir = path.join(currentRoot, typeEntry.name)
    await fs.promises.mkdir(targetTypeDir, { recursive: true })

    const sessionEntries = await fs.promises.readdir(sourceTypeDir, { withFileTypes: true }).catch(() => [])
    for (const sessionEntry of sessionEntries) {
      const sourceEntryPath = path.join(sourceTypeDir, sessionEntry.name)
      const targetEntryPath = path.join(targetTypeDir, sessionEntry.name)

      if (fs.existsSync(targetEntryPath)) {
        continue
      }

      try {
        await fs.promises.rename(sourceEntryPath, targetEntryPath)
      } catch (error) {
        logMainWarn('迁移旧版会话缓存失败', {
          domain: 'cache.lifecycle',
          action: 'migrateLegacySessionCaches',
          detail: `${sourceEntryPath} -> ${targetEntryPath}\n${error instanceof Error ? error.message : String(error)}`
        })
      }
    }

    const remainingEntries = await fs.promises.readdir(sourceTypeDir).catch(() => [])
    if (remainingEntries.length === 0) {
      await fs.promises.rm(sourceTypeDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  const remainingLegacyEntries = await fs.promises.readdir(legacyRoot).catch(() => [])
  if (remainingLegacyEntries.length === 0) {
    await fs.promises.rm(getOutputCacheRoot(projectRoot), { recursive: true, force: true }).catch(() => undefined)
  }
}

function bringWindowToFront(targetWindow: BrowserWindow | null) {
  if (!targetWindow) {
    return
  }

  if (targetWindow.isMinimized()) {
    targetWindow.restore()
  }

  if (!targetWindow.isVisible()) {
    targetWindow.show()
  }

  targetWindow.setAlwaysOnTop(true, 'screen-saver')
  targetWindow.moveTop()
  targetWindow.focus()
  targetWindow.setAlwaysOnTop(false)
}

const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    bringWindowToFront(win)
  })
}

function getAppPaths() {
  const projectRoot = getProjectRoot()
  const modelsInfo = resolveModelsRoot(projectRoot)
  const runtimeInfo = resolveRuntimeRoot(projectRoot)
  return {
    projectRoot,
    outputDir: getDefaultOutputDir(),
    cacheDir: getCacheRoot(projectRoot),
    logsDir: getLogsDir(projectRoot),
    backendLogPath: getBackendLogPath(projectRoot),
    modelsRoot: modelsInfo.modelsRoot,
    defaultModelsRoot: modelsInfo.defaultModelsRoot,
    configuredModelsRoot: modelsInfo.configuredModelsRoot,
    usingCustomModelsRoot: modelsInfo.usingCustomRoot,
    protectedDefaultModelsRoot: modelsInfo.protectedDefaultRoot,
    runtimeRoot: runtimeInfo.runtimeRoot,
    defaultRuntimeRoot: runtimeInfo.defaultRuntimeRoot,
    configuredRuntimeRoot: runtimeInfo.configuredRuntimeRoot,
    usingCustomRuntimeRoot: runtimeInfo.usingCustomRoot,
    protectedDefaultRuntimeRoot: runtimeInfo.protectedDefaultRoot
  }
}

function ensureDirectorySync(targetPath: string) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true })
  }
}

function getLicensingRoot() {
  return path.join(app.getPath('userData'), 'licensing')
}

function getLicenseCachePath() {
  return path.join(getLicensingRoot(), LICENSE_CACHE_FILE)
}

function getEmbeddedTrustedLicensePublicKeyPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'licensing', LICENSE_PUBLIC_KEY_FILE)
    : path.join(getProjectRoot(), 'resources', 'licensing-authority', LICENSE_PUBLIC_KEY_FILE)
}

function canonicalizeForSigning(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map((item) => normalize(item))
    }
    if (input && typeof input === 'object') {
      const sortedEntries = Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)])
      return Object.fromEntries(sortedEntries)
    }
    return input
  }

  return JSON.stringify(normalize(value))
}

function bytesToHex(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('hex')
}

function hexToBytes(hex: string) {
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

function encodeUint32(value: number) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32BE(value >>> 0, 0)
  return Uint8Array.from(buffer)
}

function decodeUint32(bytes: Uint8Array, offset: number) {
  return Buffer.from(bytes.slice(offset, offset + 4)).readUInt32BE(0)
}

function concatBytes(...parts: Uint8Array[]) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function encodeBase32Crockford(bytes: Uint8Array) {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += BASE32_CROCKFORD_ALPHABET[(value << (5 - bits)) & 31]
  }
  return output
}

function decodeBase32Crockford(value: string) {
  const lookup = new Map<string, number>()
  for (let index = 0; index < BASE32_CROCKFORD_ALPHABET.length; index += 1) {
    lookup.set(BASE32_CROCKFORD_ALPHABET[index], index)
  }
  lookup.set('O', 0)
  lookup.set('I', 1)
  lookup.set('L', 1)

  let bits = 0
  let current = 0
  const output: number[] = []
  for (const rawChar of value.toUpperCase()) {
    if (!rawChar || rawChar === '-' || /\s/.test(rawChar)) continue
    const digit = lookup.get(rawChar)
    if (digit === undefined) {
      throw new Error(`授权码包含无效字符: ${rawChar}`)
    }
    current = (current << 5) | digit
    bits += 5
    if (bits >= 8) {
      output.push((current >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(output)
}

function normalizeShortDeviceCode(value: unknown) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
}

function isCanonicalShortDeviceCode(value: unknown) {
  return typeof value === 'string' && /^[0-9A-HJKMNPQRSTVWXYZ]{20}$/i.test(value.trim())
}

function encodeAsciiBytes(value: string) {
  return Uint8Array.from(Buffer.from(value, 'ascii'))
}

function buildCompactLicensePayloadBytes(payload: LicensePayloadRecord, keyFingerprint: string) {
  const planCode = PLAN_CODE_BY_ID[payload.planId]
  if (!planCode) {
    throw new Error('未找到对应套餐编码。')
  }

  const validFromSeconds = Math.floor(new Date(payload.validFrom).getTime() / 1000)
  const validUntilSeconds = Math.floor(new Date(payload.validUntil).getTime() / 1000)
  if (!Number.isFinite(validFromSeconds) || !Number.isFinite(validUntilSeconds)) {
    throw new Error('许可证时间字段无效。')
  }

  const licenseNonceHex = payload.licenseId.replace(/^LIC-/i, '').trim()
  if (!/^[a-f0-9]{12,16}$/i.test(licenseNonceHex)) {
    throw new Error('许可证编号格式无效。')
  }

  const nonceBytes = Buffer.alloc(8, 0)
  Buffer.from(licenseNonceHex.padEnd(16, '0').slice(0, 16), 'hex').copy(nonceBytes)

  const bindingVersion = payload.deviceBinding?.fingerprintVersion || 'cpu-v1'
  const bindingValue = String(payload.deviceBinding?.fingerprint || '').trim()
  if (bindingVersion === 'cpu-v1') {
    if (!/^[a-f0-9]{64}$/i.test(bindingValue)) {
      throw new Error('许可证缺少有效的设备指纹。')
    }
    return concatBytes(
      Uint8Array.from(Buffer.from(ACTIVATION_CODE_MAGIC, 'ascii')),
      Uint8Array.from([1]),
      hexToBytes(keyFingerprint),
      Uint8Array.from([planCode]),
      encodeUint32(validFromSeconds),
      encodeUint32(validUntilSeconds),
      hexToBytes(bindingValue),
      Uint8Array.from(nonceBytes)
    )
  }

  if (bindingVersion !== SHORT_DEVICE_CODE_VERSION || !isCanonicalShortDeviceCode(bindingValue)) {
    throw new Error('许可证缺少有效的短设备码。')
  }

  return concatBytes(
    Uint8Array.from(Buffer.from(ACTIVATION_CODE_MAGIC, 'ascii')),
    Uint8Array.from([ACTIVATION_CODE_VERSION]),
    hexToBytes(keyFingerprint),
    Uint8Array.from([planCode]),
    encodeUint32(validFromSeconds),
    encodeUint32(validUntilSeconds),
    encodeAsciiBytes(bindingValue),
    Uint8Array.from(nonceBytes)
  )
}

function decodeCompactActivationCode(rawCode: string): LicenseEnvelopeRecord {
  const normalized = String(rawCode || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (!normalized) {
    throw new Error('授权码不能为空。')
  }

  const decoded = decodeBase32Crockford(normalized)
  const signatureSize = 64
  if (decoded.length <= signatureSize) {
    throw new Error('授权码长度无效。')
  }

  const version = decoded[4]
  const payloadSize = version === 1 ? 62 : version === ACTIVATION_CODE_VERSION ? 50 : -1
  if (payloadSize < 0 || decoded.length !== payloadSize + signatureSize) {
    throw new Error('授权码长度无效。')
  }

  const compactPayload = decoded.slice(0, payloadSize)
  const signatureBytes = decoded.slice(payloadSize)
  const magic = Buffer.from(compactPayload.slice(0, 4)).toString('ascii')
  if (magic !== ACTIVATION_CODE_MAGIC) {
    throw new Error('授权码标识无效。')
  }
  if (version !== 1 && version !== ACTIVATION_CODE_VERSION) {
    throw new Error('授权码版本不受支持。')
  }

  const keyFingerprint = bytesToHex(compactPayload.slice(5, 13)).toUpperCase()
  const planCode = compactPayload[13]
  const planId = PLAN_ID_BY_CODE.get(planCode)
  const plan = LICENSE_PLANS.find((item) => item.id === planId)
  if (!planId || !plan) {
    throw new Error('授权码套餐编码无效。')
  }

  const validFrom = new Date(decodeUint32(compactPayload, 14) * 1000).toISOString()
  const validUntil = new Date(decodeUint32(compactPayload, 18) * 1000).toISOString()
  const deviceBindingValue = version === 1
    ? bytesToHex(compactPayload.slice(22, 54)).toLowerCase()
    : Buffer.from(compactPayload.slice(22, 42)).toString('ascii').toUpperCase()
  const nonceHex = bytesToHex(compactPayload.slice(version === 1 ? 54 : 42, version === 1 ? 62 : 50)).toUpperCase().replace(/0+$/g, '') || '000000000000'
  const bindingVersion: 'cpu-v1' | 'cpu-short-v1' = version === 1 ? 'cpu-v1' : SHORT_DEVICE_CODE_VERSION

  return {
    signatureAlgorithm: 'ed25519',
    keyFingerprint,
    signature: Buffer.from(signatureBytes).toString('base64'),
    payload: {
      schemaVersion: 1,
      licenseId: `LIC-${nonceHex}`,
      product: LICENSE_PRODUCT_NAME,
      edition: 'Commercial',
      customerName: deviceBindingValue,
      customerEmail: 'activation@local',
      planId: plan.id,
      planName: plan.name,
      cycle: plan.cycle,
      priceCny: plan.priceCny,
      currency: 'CNY',
      issuedAt: validFrom,
      validFrom,
      validUntil,
      maxDevices: 1,
      features: plan.features,
      operator: 'RRQ-DS',
      status: 'active',
      notes: ACTIVATION_CODE_NOTE,
      deviceBinding: {
        mode: 'required',
        fingerprint: deviceBindingValue,
        fingerprintVersion: bindingVersion,
        label: deviceBindingValue.toUpperCase()
      }
    }
  }
}

function normalizeMachineToken(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim().replace(/\s+/g, ' ').toUpperCase()
  if (!normalized) {
    return undefined
  }

  const ignored = new Set([
    'UNKNOWN',
    'DEFAULT STRING',
    'SYSTEM SERIAL NUMBER',
    'TO BE FILLED BY O.E.M.',
    'TO BE FILLED BY OEM',
    'NONE',
    'N/A',
    'NOT APPLICABLE',
    'NOT SPECIFIED'
  ])

  return ignored.has(normalized) ? undefined : normalized
}

function isCanonicalMachineFingerprint(value: unknown) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim())
}

function buildCpuMachineFingerprintInfo() {
  const primaryCpu = os.cpus()?.[0]
  const cpuModel = normalizeMachineToken(primaryCpu?.model) || 'UNKNOWN-CPU'
  const cpuCount = String(os.cpus()?.length || 1)
  const hostName = os.hostname() || process.env.COMPUTERNAME || 'unknown-host'
  const raw = [
    LICENSE_PRODUCT_NAME,
    'cpu-v1',
    os.platform(),
    os.arch(),
    hostName,
    cpuModel,
    cpuCount
  ].join('|')
  const fingerprint = createHash('sha256').update(raw).digest('hex')
  const shortFingerprint = encodeBase32Crockford(
    Uint8Array.from(createHash('sha256').update(`VSM-DEVICE-CODE|${fingerprint}`).digest().subarray(0, 13))
  ).slice(0, SHORT_DEVICE_CODE_LENGTH)

  return {
    fingerprint,
    shortFingerprint,
    fingerprintVersion: 'cpu-v1' as const,
    hostName,
    platform: os.platform(),
    arch: os.arch(),
    appVersion: app.getVersion()
  }
}

function buildMachineFingerprintInfo() {
  return buildCpuMachineFingerprintInfo()
}

function buildUnavailableMachineFingerprintInfo(reason?: string): MachineFingerprintInfoRecord {
  return {
    shortFingerprint: 'UNAVAILABLE',
    appVersion: app.getVersion(),
    hostName: os.hostname() || process.env.COMPUTERNAME || 'unknown-host',
    platform: os.platform(),
    arch: os.arch(),
    available: false,
    reason: reason || '当前设备暂时无法生成 CPU 绑定指纹。'
  }
}

function getMachineFingerprintInfoSafe(): MachineFingerprintInfoRecord {
  try {
    return {
      ...buildMachineFingerprintInfo(),
      available: true
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logMainWarn('CPU 指纹读取失败', {
      domain: 'licensing.machine',
      action: 'getMachineFingerprintInfoSafe',
      detail: reason
    })
    return buildUnavailableMachineFingerprintInfo(reason)
  }
}

function encryptLicenseEnvelope(envelope: LicenseEnvelopeRecord) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法写入授权缓存。')
  }

  return {
    importedAt: new Date().toISOString(),
    ciphertext: safeStorage.encryptString(JSON.stringify(envelope)).toString('base64')
  }
}

function decryptLicenseEnvelopeCache(raw: string): LicenseEnvelopeRecord {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法读取授权缓存。')
  }

  const payload = JSON.parse(raw) as { ciphertext: string }
  const plaintext = safeStorage.decryptString(Buffer.from(payload.ciphertext, 'base64'))
  return JSON.parse(plaintext) as LicenseEnvelopeRecord
}

function loadTrustedLicensePublicKey() {
  const publicKeyPath = getEmbeddedTrustedLicensePublicKeyPath()
  if (!fs.existsSync(publicKeyPath)) {
    throw new Error('未检测到内置授权公钥，无法完成授权校验。')
  }

  const publicKeyPem = fs.readFileSync(publicKeyPath, 'utf8')
  const fingerprint = createHash('sha256').update(publicKeyPem.trim()).digest('hex').slice(0, 16).toUpperCase()
  if (fingerprint !== TRUSTED_LICENSE_PUBLIC_KEY_FINGERPRINT) {
    throw new Error('内置授权公钥指纹不匹配，已拒绝加载。')
  }

  return publicKeyPem
}

function verifyLicenseEnvelope(envelope: LicenseEnvelopeRecord) {
  let publicKeyPem = ''
  try {
    publicKeyPem = loadTrustedLicensePublicKey()
  } catch (error) {
    return { verified: false, validNow: false, reason: error instanceof Error ? error.message : String(error) }
  }

  const message = envelope.payload.notes === ACTIVATION_CODE_NOTE
    ? Buffer.from(buildCompactLicensePayloadBytes(envelope.payload, envelope.keyFingerprint))
    : Buffer.from(canonicalizeForSigning(envelope.payload))

  const signatureOk = cryptoVerify(null, message, publicKeyPem, Buffer.from(envelope.signature, 'base64'))

  if (!signatureOk) {
    return { verified: false, validNow: false, reason: '许可证签名校验失败。' }
  }

  const now = Date.now()
  const validFrom = new Date(envelope.payload.validFrom).getTime()
  const validUntil = new Date(envelope.payload.validUntil).getTime()

  if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil)) {
    return { verified: true, validNow: false, reason: '许可证时间字段无效。' }
  }

  if (envelope.payload.status !== 'active') {
    return { verified: true, validNow: false, reason: '许可证当前状态不可用。' }
  }

  if (now < validFrom) {
    return { verified: true, validNow: false, reason: '许可证尚未生效。' }
  }

  if (now > validUntil) {
    return { verified: true, validNow: false, reason: '许可证已到期。' }
  }

  if (envelope.payload.deviceBinding?.mode === 'required') {
    const currentMachine = buildMachineFingerprintInfo()
    const bindingVersion = envelope.payload.deviceBinding.fingerprintVersion || 'cpu-v1'
    const bindingFingerprint = String(envelope.payload.deviceBinding.fingerprint || '').trim().toLowerCase()
    if (bindingVersion === 'cpu-v1') {
      const currentFingerprint = String(currentMachine.fingerprint || '').trim().toLowerCase()
      if (!isCanonicalMachineFingerprint(bindingFingerprint)) {
        return { verified: true, validNow: false, reason: '许可证设备识别码格式无效。' }
      }
      if (bindingFingerprint !== currentFingerprint) {
        return { verified: true, validNow: false, reason: '许可证与当前设备指纹不匹配。' }
      }
    } else if (bindingVersion === SHORT_DEVICE_CODE_VERSION) {
      const currentShortCode = normalizeShortDeviceCode(currentMachine.shortFingerprint)
      if (!isCanonicalShortDeviceCode(bindingFingerprint)) {
        return { verified: true, validNow: false, reason: '许可证短设备码格式无效。' }
      }
      if (bindingFingerprint.toUpperCase() !== currentShortCode) {
        return { verified: true, validNow: false, reason: '许可证与当前设备码不匹配。' }
      }
    } else {
      return { verified: true, validNow: false, reason: '许可证设备绑定版本不受支持。' }
    }
  }

  return { verified: true, validNow: true }
}

function readActiveLicenseStatus() {
  const cachePath = getLicenseCachePath()
  if (!fs.existsSync(cachePath)) {
    return { exists: false, verified: false, validNow: false }
  }

  try {
    const raw = fs.readFileSync(cachePath, 'utf8')
    const cachePayload = JSON.parse(raw) as { importedAt?: string }
    const envelope = decryptLicenseEnvelopeCache(raw)
    const verification = verifyLicenseEnvelope(envelope)
    return {
      exists: true,
      verified: verification.verified,
      validNow: verification.validNow,
      reason: verification.reason,
      importedAt: cachePayload.importedAt,
      planId: envelope.payload.planId,
      planName: envelope.payload.planName,
      cycle: envelope.payload.cycle,
      validFrom: envelope.payload.validFrom,
      validUntil: envelope.payload.validUntil,
      maxDevices: envelope.payload.maxDevices
    }
  } catch (error) {
    return {
      exists: true,
      verified: false,
      validNow: false,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

function buildLicensingOverview() {
  const machine = getMachineFingerprintInfoSafe()
  return {
    success: machine.available !== false,
    plans: LICENSE_PLANS,
    machine: {
      shortFingerprint: machine.shortFingerprint,
      appVersion: machine.appVersion,
      available: machine.available,
      reason: machine.reason
    },
    activeLicense: readActiveLicenseStatus(),
    error: machine.available === false ? machine.reason : undefined
  }
}

function decodeActivationCode(rawCode: string): LicenseEnvelopeRecord {
  const normalized = String(rawCode || '').trim()
  if (!normalized) {
    throw new Error('授权码不能为空。')
  }

  try {
    return decodeCompactActivationCode(normalized)
  } catch {
    // fall through to legacy formats
  }

  try {
    const jsonText = Buffer.from(normalized, 'base64url').toString('utf8')
    return JSON.parse(jsonText) as LicenseEnvelopeRecord
  } catch {
    try {
      return JSON.parse(normalized) as LicenseEnvelopeRecord
    } catch (error) {
      throw new Error(`授权码格式无效。${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function getBackendActionFromArgs(args: string[]) {
  const actionIndex = args.indexOf('--action')
  if (actionIndex < 0 || actionIndex + 1 >= args.length) {
    return null
  }
  const action = args[actionIndex + 1]
  return typeof action === 'string' && action.trim() ? action.trim() : null
}

function buildBackendLicenseTicket(action: string, lane: BackendLane) {
  const payload = {
    action,
    lane,
    exp: Date.now() + LICENSE_TICKET_TTL_MS,
    nonce: randomBytes(12).toString('hex')
  }
  const serialized = JSON.stringify(payload)
  const token = Buffer.from(serialized, 'utf8').toString('base64url')
  const signature = createHmac('sha256', backendLicenseTicketSecret).update(token).digest('hex')
  return { token, signature }
}

function withBackendLicenseTicket(args: string[], lane: BackendLane) {
  const action = getBackendActionFromArgs(args)
  if (!action || !LICENSE_PROTECTED_BACKEND_ACTIONS.has(action)) {
    return args
  }

  const { token, signature } = buildBackendLicenseTicket(action, lane)
  return [
    ...args,
    '--license_ticket',
    token,
    '--license_ticket_sig',
    signature
  ]
}

function getBackendActionLicenseError(action: string | null) {
  if (!action || !LICENSE_PROTECTED_BACKEND_ACTIONS.has(action)) {
    return null
  }

  const licenseStatus = readActiveLicenseStatus()
  if (licenseStatus.validNow) {
    return null
  }

  const detail = licenseStatus.reason || '当前客户端未激活有效授权。'
  logMainDebug('拦截未授权后端任务', {
    domain: 'licensing.enforcement',
    action: 'getBackendActionLicenseError',
    detail: `${action} | ${detail}`
  })
  return `当前功能需要有效许可证。请先在“授权中心”输入授权码完成激活。\n\n${detail}`
}


function activateLicenseFromCode(activationCode: string) {
  const envelope = decodeActivationCode(activationCode)
  const verification = verifyLicenseEnvelope(envelope)
  if (!verification.verified) {
    return { success: false, error: verification.reason || '许可证签名校验失败。' }
  }

  ensureDirectorySync(getLicensingRoot())
  fs.writeFileSync(getLicenseCachePath(), JSON.stringify(encryptLicenseEnvelope(envelope), null, 2), 'utf8')

  return {
    success: true,
    activeLicense: readActiveLicenseStatus()
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
let shutdownCleanupState: 'idle' | 'running' | 'completed' = 'idle'
let allowQuitAfterCleanup = false

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
  const { projectRoot, modelsRoot } = getAppPaths()
  const pythonExe = path.join(getPythonRoot(projectRoot), 'python.exe')
  const scriptPath = path.join(getBackendRoot(projectRoot), 'main.py')
  const finalPythonExe = (app.isPackaged || fs.existsSync(pythonExe)) ? pythonExe : 'python'

  return {
    projectRoot,
    scriptPath,
    modelsDir: modelsRoot,
    finalPythonExe
  }
}

async function ensureBackendWorker(lane: BackendLane) {
  const workerState = getBackendWorkerState(lane)
  if (workerState.process && workerState.process.exitCode === null && !workerState.process.killed) {
    return workerState.process as ChildProcess
  }

  if (app.isPackaged) {
    const runtimeReady = await ensurePackagedPythonRuntime()
    if (!runtimeReady.success) {
      throw new Error(runtimeReady.error || 'Python runtime installation failed')
    }
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
    [LICENSE_TICKET_SECRET_ENV]: backendLicenseTicketSecret,
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

async function cleanupExpiredCacheSessions(options?: { forceAll?: boolean }) {
  const { projectRoot, cacheDir } = getAppPaths()
  const forceAll = options?.forceAll === true
  const cleanupRoots = {
    legacySessions: getSessionCacheRoot(projectRoot),
    outputSessions: getOutputSessionCacheRoot(projectRoot),
    sources: path.join(cacheDir, 'sources'),
    previews: path.join(cacheDir, 'previews'),
    sourceSeparation: path.join(cacheDir, 'source_separation'),
    rife: path.join(cacheDir, 'rife')
  }

  async function removeExpiredSessionEntries(rootPath: string) {
    await fs.promises.mkdir(rootPath, { recursive: true })
    const now = Date.now()
    const entries = await fs.promises.readdir(rootPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const entryPath = path.join(rootPath, entry.name)
      try {
        const stat = await fs.promises.stat(entryPath)
        const lastTouched = Math.max(
          stat.atimeMs || 0,
          stat.mtimeMs || 0,
          stat.birthtimeMs || 0
        )
        if (!forceAll && now - lastTouched <= CACHE_RETENTION_MS) {
          continue
        }

        const manifestPath = path.join(entryPath, 'session-manifest.json')
        let finalDir = ''
        try {
          const raw = await fs.promises.readFile(manifestPath, 'utf-8')
          const manifest = JSON.parse(raw) as SessionManifestCleanupSnapshot
          finalDir = String(manifest?.artifacts?.finalDir || '')
        } catch {
          finalDir = ''
        }

        await fs.promises.rm(entryPath, { recursive: true, force: true })
        if (finalDir) {
          await fs.promises.rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
        }

        logMainDebug('清理过期恢复会话', {
          domain: 'cache.lifecycle',
          action: 'cleanupExpiredCacheSessions',
          detail: finalDir ? `${entryPath}\n${finalDir}` : entryPath
        })
      } catch (error) {
        logMainError('检查恢复会话失败', {
          domain: 'cache.lifecycle',
          action: 'cleanupExpiredCacheSessions',
          detail: `${entryPath}\n${error instanceof Error ? error.message : String(error)}`
        })
      }
    }
  }

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

        if (forceAll || now - lastTouched > CACHE_RETENTION_MS) {
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
    for (const sessionsRoot of [cleanupRoots.legacySessions, cleanupRoots.outputSessions]) {
      const sessionTypeDirs = await fs.promises.readdir(sessionsRoot, { withFileTypes: true }).catch(async () => {
        await fs.promises.mkdir(sessionsRoot, { recursive: true })
        return []
      })

      for (const typeDir of sessionTypeDirs) {
        if (!typeDir.isDirectory()) continue

        const typeDirPath = path.join(sessionsRoot, typeDir.name)
        await removeExpiredSessionEntries(typeDirPath)
      }
    }

    await removeExpiredEntries(cleanupRoots.sources, false)
    await removeExpiredEntries(cleanupRoots.previews, false)
    await removeExpiredEntries(cleanupRoots.sourceSeparation, true)
    await removeExpiredEntries(cleanupRoots.rife, true)
  } catch (error) {
    logMainError('启动阶段缓存清理失败', {
      domain: 'cache.lifecycle',
      action: 'cleanupExpiredCacheSessions',
      detail: error instanceof Error ? error.message : String(error)
    })
  }
}

interface SessionManifestCleanupSnapshot {
  phase?: string
  artifacts?: {
    finalDir?: string
  }
}

async function removePureCacheDirectoriesOnQuit(projectRoot = getProjectRoot()) {
  const cacheRoot = getCacheRoot(projectRoot)
  const pureCacheDirs = [
    path.join(cacheRoot, 'sources'),
    path.join(cacheRoot, 'previews'),
    path.join(cacheRoot, 'source_separation'),
    path.join(cacheRoot, 'rife')
  ]

  for (const targetDir of pureCacheDirs) {
    await fs.promises.rm(targetDir, { recursive: true, force: true }).catch(() => undefined)
  }

  const cacheEntries = await fs.promises.readdir(cacheRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of cacheEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith('electron.backup-')) continue
    await fs.promises.rm(path.join(cacheRoot, entry.name), { recursive: true, force: true }).catch(() => undefined)
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

function isBenignPowerShellKillMessage(message: string) {
  const text = message.toLowerCase()
  return (
    text.includes('cannot find a process') ||
    text.includes('cannot find the process') ||
    text.includes('no process') ||
    text.includes('找不到') ||
    text.includes('没有')
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

async function terminateTrackedChildProcesses() {
  const workerProcesses = (Object.keys(backendWorkers) as BackendLane[])
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

  const downloadProcesses = Array.from(activeDownloads.values())
  activeDownloads.clear()

  const trackedProcesses = [...workerProcesses, ...downloadProcesses].filter(
    (proc, index, list) => Boolean(proc?.pid) && list.findIndex((candidate) => candidate.pid === proc.pid) === index
  )

  if (trackedProcesses.length === 0) {
    return true
  }

  try {
    const results = await Promise.all(
      trackedProcesses.map(async (proc) => {
        logMainSecurity('终止退出阶段子进程', {
          domain: 'process.control',
          action: 'terminateTrackedChildProcesses',
          detail: `pid=${proc.pid}`
        })
        return terminateProcessTree(proc)
      })
    )
    return results.every(Boolean)
  } catch (error) {
    logMainError('退出阶段停止子进程失败', {
      domain: 'process.control',
      action: 'terminateTrackedChildProcesses',
      detail: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

async function terminateResidualGptSovitsServers(projectRoot = getProjectRoot()) {
  const runtimeInfo = resolveRuntimeRoot(projectRoot)
  const scriptPath = path.join(projectRoot, 'services', 'media_pipeline', 'gpt_sovits_api_server.py')
  const pythonPath = path.join(runtimeInfo.runtimeRoot, 'gpt_sovits', 'venv', 'Scripts', 'python.exe')
  const stateFilePath = path.join(runtimeInfo.runtimeRoot, 'gpt_sovits', 'api_v2.state.json')

  if (process.platform !== 'win32') {
    await fs.promises.rm(stateFilePath, { force: true }).catch(() => undefined)
    return true
  }

  const escapedScriptPath = scriptPath.replace(/'/g, "''")
  const escapedPythonPath = pythonPath.replace(/'/g, "''")

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          [
            `$scriptPath = '${escapedScriptPath}'`,
            `$pythonPath = '${escapedPythonPath}'`,
            "$targets = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*gpt_sovits_api_server.py*' -and $_.CommandLine -like ('*' + $scriptPath + '*') -and $_.CommandLine -like ('*' + $pythonPath + '*') }",
            'foreach ($proc in $targets) {',
            '  try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch { }',
            '}'
          ].join('; '),
        ],
        { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 4 },
        (error, stdout, stderr) => {
          const combinedOutput = `${stdout || ''}\n${stderr || ''}`.trim()
          if (error && !isBenignPowerShellKillMessage(combinedOutput)) {
            reject(new Error(combinedOutput || error.message))
            return
          }
          resolve()
        }
      )
    })
  } catch (error) {
    logMainError('清理残留 GPT-SoVITS 服务失败', {
      domain: 'process.control',
      action: 'terminateResidualGptSovitsServers',
      detail: error instanceof Error ? error.message : String(error)
    })
    return false
  }

  await fs.promises.rm(stateFilePath, { force: true }).catch(() => undefined)
  logMainSecurity('完成 GPT-SoVITS 残留服务清理', {
    domain: 'process.control',
    action: 'terminateResidualGptSovitsServers',
    detail: scriptPath
  })
  return true
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
      webSecurity: false, // Allow loading local resources (file://)
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
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

  if (app.isPackaged) {
    win.webContents.on('devtools-opened', () => {
      win?.webContents.closeDevTools()
      logMainSecurity('生产态阻止 DevTools 打开', {
        domain: 'window.security',
        action: 'devtools-opened'
      })
    })
  }

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

app.on('before-quit', (event) => {
  if (allowQuitAfterCleanup || shutdownCleanupState === 'completed') {
    return
  }

  event.preventDefault()
  if (shutdownCleanupState === 'running') {
    return
  }

  shutdownCleanupState = 'running'
  void Promise.all([
    terminateTrackedChildProcesses(),
    terminateResidualGptSovitsServers(),
    removePureCacheDirectoriesOnQuit()
  ])
    .catch((error) => {
      logMainError('关闭应用时退出清理失败', {
        domain: 'app.lifecycle',
        action: 'before-quit',
        detail: error instanceof Error ? error.message : String(error)
      })
    })
    .finally(() => {
      shutdownCleanupState = 'completed'
      allowQuitAfterCleanup = true
      app.quit()
    })
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

  await terminateResidualGptSovitsServers().catch(() => undefined)

  // Check and install VC++ Runtime before creating window
  await checkAndInstallVCRuntime();
  await migrateLegacySessionCaches();
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

  ipcMain.handle('get-model-root-settings', async () => {
    const resolved = resolveModelsRoot()
    return {
      success: true,
      root: resolved.modelsRoot,
      defaultRoot: resolved.defaultModelsRoot,
      managedRoot: resolved.managedModelsRoot,
      configuredRoot: resolved.configuredModelsRoot,
      usingCustomRoot: resolved.usingCustomRoot,
      protectedDefaultRoot: resolved.protectedDefaultRoot
    }
  })

  ipcMain.handle('set-model-root-settings', async (_event, payload) => {
    void _event
    try {
      const projectRoot = getProjectRoot()
      const current = resolveModelsRoot(projectRoot)
      const requestedRoot = normalizeConfiguredModelsRoot(payload?.modelsRoot)
      const useDefault = payload?.useDefault === true || !requestedRoot
      const nextConfiguredRoot = useDefault ? null : requestedRoot
      const nextResolvedRoot = nextConfiguredRoot || current.defaultModelsRoot

      if (nextConfiguredRoot && !path.isAbsolute(nextConfiguredRoot)) {
        return { success: false, error: '模型目录必须是绝对路径。' }
      }

      if (isProtectedInstallLocation(nextResolvedRoot)) {
        return { success: false, error: '目标目录位于 Program Files 等受保护位置，无法直接写入。请选择用户可写目录。' }
      }

      if (current.modelsRoot !== nextResolvedRoot) {
        await terminateTrackedChildProcesses()
      }

      fs.mkdirSync(nextResolvedRoot, { recursive: true })

      if (payload?.migrateExisting === true) {
        migrateModelsRootContents(current.modelsRoot, nextResolvedRoot)
      }

      writeModelRootSettings(
        nextConfiguredRoot ? { customModelsRoot: nextConfiguredRoot } : {},
        projectRoot
      )

      const updated = resolveModelsRoot(projectRoot)
      return {
        success: true,
        root: updated.modelsRoot,
        defaultRoot: updated.defaultModelsRoot,
        managedRoot: updated.managedModelsRoot,
        configuredRoot: updated.configuredModelsRoot,
        usingCustomRoot: updated.usingCustomRoot,
        protectedDefaultRoot: updated.protectedDefaultRoot
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('get-runtime-root-settings', async () => {
    const resolved = resolveRuntimeRoot()
    return {
      success: true,
      root: resolved.runtimeRoot,
      defaultRoot: resolved.defaultRuntimeRoot,
      managedRoot: resolved.managedRuntimeRoot,
      configuredRoot: resolved.configuredRuntimeRoot,
      usingCustomRoot: resolved.usingCustomRoot,
      protectedDefaultRoot: resolved.protectedDefaultRoot
    }
  })

  ipcMain.handle('set-runtime-root-settings', async (_event, payload) => {
    void _event
    try {
      const projectRoot = getProjectRoot()
      const current = resolveRuntimeRoot(projectRoot)
      const requestedRoot = normalizeConfiguredRuntimeRoot(payload?.runtimeRoot)
      const useDefault = payload?.useDefault === true || !requestedRoot
      const nextConfiguredRoot = useDefault ? null : requestedRoot
      const nextResolvedRoot = nextConfiguredRoot || current.defaultRuntimeRoot

      if (nextConfiguredRoot && !path.isAbsolute(nextConfiguredRoot)) {
        return { success: false, error: '运行环境目录必须是绝对路径。' }
      }

      if (isProtectedInstallLocation(nextResolvedRoot)) {
        return { success: false, error: '目标目录位于 Program Files 等受保护位置，无法直接写入。请选择用户可写目录。' }
      }

      if (current.runtimeRoot !== nextResolvedRoot) {
        await terminateTrackedChildProcesses()
      }

      fs.mkdirSync(nextResolvedRoot, { recursive: true })

      if (payload?.migrateExisting === true) {
        migrateModelsRootContents(current.runtimeRoot, nextResolvedRoot)
      }

      writeRuntimeRootSettings(
        nextConfiguredRoot ? { customRuntimeRoot: nextConfiguredRoot } : {},
        projectRoot
      )

      const updated = resolveRuntimeRoot(projectRoot)
      return {
        success: true,
        root: updated.runtimeRoot,
        defaultRoot: updated.defaultRuntimeRoot,
        managedRoot: updated.managedRuntimeRoot,
        configuredRoot: updated.configuredRuntimeRoot,
        usingCustomRoot: updated.usingCustomRoot,
        protectedDefaultRoot: updated.protectedDefaultRoot
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('get-runtime-download-info', async () => {
    return getRuntimeDownloadInfo();
  })

  ipcMain.handle('get-licensing-overview', async () => {
    try {
      return buildLicensingOverview()
    } catch (error) {
      return {
        success: false,
        plans: LICENSE_PLANS,
        machine: buildUnavailableMachineFingerprintInfo(error instanceof Error ? error.message : String(error)),
        activeLicense: readActiveLicenseStatus(),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('activate-license-code', async (_event, payload) => {
    void _event
    try {
      return activateLicenseFromCode(String(payload?.activationCode || ''))
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
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
    const action = getBackendActionFromArgs(requestArgs)
    const licenseError = getBackendActionLicenseError(action)
    if (licenseError) {
      return {
        success: false,
        error: licenseError,
        error_code: 'LICENSE_REQUIRED',
        license_required: true
      }
    }
    const finalArgs = withBackendLicenseTicket(requestArgs, lane)

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

        backendProcess.stdin.write(`${JSON.stringify({ id: requestId, args: finalArgs })}\n`, 'utf8')
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
      if (/^https?:\/\//i.test(filePath)) {
        await shell.openExternal(filePath);
      } else {
        await shell.openPath(filePath);
      }
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
    return terminateTrackedChildProcesses()
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
        if (app.isPackaged) {
          void ensurePackagedPythonRuntime()
            .then((runtimeResult) => {
              if (!runtimeResult.success) {
                resolve({ success: false, error: runtimeResult.error || 'Python runtime installation failed' });
                return;
              }

              const pythonExe = path.join(getPythonRoot(projectRoot), 'python.exe');
              const requirementsPath = path.join(projectRoot, 'requirements.txt');

              if (!fs.existsSync(pythonExe)) {
                resolve({ success: false, error: `找不到 Python 解释器。请确认运行时目录存在于 ${getManagedPythonLocationHint(projectRoot)}` });
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
            })
            .catch((error: unknown) => {
              resolve({
                success: false,
                error: buildRuntimeManualDownloadMessage(
                  error instanceof Error ? error.message : String(error),
                  projectRoot
                )
              });
            });
          return;
        }

        const pythonExe = path.join(getPythonRoot(projectRoot), 'python.exe');
        const requirementsPath = path.join(projectRoot, 'requirements.txt');

        if (!fs.existsSync(pythonExe)) {
          resolve({ success: false, error: `找不到 Python 解释器。请确认运行时目录存在于 ${getManagedPythonLocationHint(projectRoot)}` });
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
          resolve({
            success: false,
            status: 'missing_python',
            error: app.isPackaged
              ? buildRuntimeManualDownloadMessage('找不到已安装的 Python 解释器', projectRoot)
              : `找不到 Python 解释器。请确认运行时目录存在于 ${getManagedPythonLocationHint(projectRoot)}`
          });
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

  ipcMain.handle('get-tts-runtime-diagnostics', async (_event, payload?: {
    ttsService?: 'indextts' | 'qwen' | 'gptsovits'
    text?: string
    duration?: number
    batchSize?: number
    ttsModelProfile?: string
    maxNewTokens?: number
    gptSovitsParallelInfer?: boolean
    gptSovitsSampleSteps?: number
    gptSovitsBatchThreshold?: number
    gptSovitsTextSplitMethod?: string
    gptSovitsOfficialFastMode?: boolean
  }) => {
    void _event
    try {
      const args = [
        '--action', 'get_tts_runtime_diagnostics',
        '--tts_service', String(payload?.ttsService || 'indextts'),
        '--text', String(payload?.text || '这是运行诊断示例文本。'),
        '--batch_size', String(payload?.batchSize || 1),
        '--max_new_tokens', String(payload?.maxNewTokens || 2048),
      ]
      if (payload?.ttsModelProfile) {
        args.push('--tts_model_profile', payload.ttsModelProfile)
      }
      if (typeof payload?.duration === 'number' && Number.isFinite(payload.duration)) {
        args.push('--duration', String(payload.duration))
      }
      if (typeof payload?.gptSovitsParallelInfer === 'boolean') {
        args.push('--gpt_sovits_parallel_infer', payload.gptSovitsParallelInfer ? 'true' : 'false')
      }
      if (typeof payload?.gptSovitsSampleSteps === 'number' && Number.isFinite(payload.gptSovitsSampleSteps)) {
        args.push('--gpt_sovits_sample_steps', String(payload.gptSovitsSampleSteps))
      }
      if (typeof payload?.gptSovitsBatchThreshold === 'number' && Number.isFinite(payload.gptSovitsBatchThreshold)) {
        args.push('--gpt_sovits_batch_threshold', String(payload.gptSovitsBatchThreshold))
      }
      if (payload?.gptSovitsTextSplitMethod) {
        args.push('--gpt_sovits_text_split_method', payload.gptSovitsTextSplitMethod)
      }
      if (typeof payload?.gptSovitsOfficialFastMode === 'boolean') {
        args.push('--gpt_sovits_official_fast_mode', payload.gptSovitsOfficialFastMode ? 'true' : 'false')
      }

      return await enqueueBackendRun('default', async () => {
        const backendProcess = await ensureBackendWorker('default')
        const workerState = getBackendWorkerState('default')
        const requestId = `req-${Date.now()}-${++workerState.requestCounter}`
        return await new Promise((resolve, reject) => {
          workerState.activeRequest = {
            requestId,
            sender: _event.sender,
            resolve,
            reject,
            cancellationState: { requested: false },
            outputData: '',
            errorData: ''
          }
          workerState.activeCancellation = { requested: false }
          if (!backendProcess.stdin || backendProcess.stdin.destroyed || !backendProcess.stdin.writable) {
            workerState.activeRequest = null
            workerState.activeCancellation = null
            reject(new Error('Backend worker stdin is not writable'))
            return
          }
          backendProcess.stdin.write(`${JSON.stringify({ id: requestId, args })}\n`, 'utf8')
        })
      })
    } catch (error) {
      logMainError('获取 TTS 运行诊断失败', {
        domain: 'runtime.diagnostics',
        action: 'get-tts-runtime-diagnostics',
        detail: error instanceof Error ? error.message : String(error)
      })
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // IPC Handler to check model status
  ipcMain.handle('check-model-status', async (_event) => {
    void _event
    return new Promise((resolve) => {
      try {
        const { modelsRoot, projectRoot } = resolveModelsRoot();
        const { runtimeRoot } = resolveRuntimeRoot(projectRoot);
        const pythonRoot = getPythonRoot(projectRoot);
        logMainDebug('检查模型目录状态', {
          domain: 'model.lifecycle',
          action: 'check-model-status',
          detail: modelsRoot
        })

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

        const overlayRuntimeDir = getRuntimeOverlayRoot('transformers5_asr', projectRoot);
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

        const getQwenTextModelStatusDetail = () => {
          const directDir = path.join(modelsRoot, 'Qwen2.5-7B-Instruct');
          const nestedDir = path.join(modelsRoot, 'Qwen', 'Qwen2.5-7B-Instruct');
          const modelDir = [directDir, nestedDir].find((candidate) => fs.existsSync(candidate));
          if (!modelDir) {
            return createStatusDetail(false, 'missing', '未找到 Qwen2.5-7B-Instruct 本地翻译模型目录。', true);
          }
          const configReady = fs.existsSync(path.join(modelDir, 'config.json'));
          const tokenizerReady = [
            path.join(modelDir, 'tokenizer.json'),
            path.join(modelDir, 'tokenizer_config.json'),
          ].some((candidate) => fs.existsSync(candidate));
          const hasWeights = [
            path.join(modelDir, 'model.safetensors'),
            path.join(modelDir, 'model.safetensors.index.json'),
            path.join(modelDir, 'pytorch_model.bin'),
            path.join(modelDir, 'pytorch_model.bin.index.json'),
          ].some((candidate) => fs.existsSync(candidate));
          if (!configReady || !tokenizerReady || !hasWeights) {
            return createStatusDetail(
              false,
              'incomplete',
              'Qwen2.5-7B-Instruct 目录存在，但缺少 config.json、tokenizer 配置或主权重文件，当前无法作为本地翻译模型加载。',
              true
            );
          }
          return createStatusDetail(true, 'ready', 'Qwen2.5-7B-Instruct 本地翻译模型已就绪。');
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

        const getGptSovitsStatusDetail = () => {
          const serviceRoot = path.join(runtimeRoot, 'gpt_sovits');
          const repoRoot = path.join(serviceRoot, 'repo');
          const venvPython = path.join(serviceRoot, 'venv', 'Scripts', 'python.exe');
          const bootstrapStatePath = path.join(serviceRoot, 'bootstrap-state.json');
          const configPath = path.join(serviceRoot, 'tts_infer.generated.yaml');
          const weightsRoot = path.join(repoRoot, 'GPT_SoVITS', 'pretrained_models');
          if (!fs.existsSync(serviceRoot)) {
            return createStatusDetail(false, 'staged', 'GPT-SoVITS 尚未初始化。首次启用时将自动下载官方仓库、依赖和预置模型。');
          }
          if (!fs.existsSync(repoRoot)) {
            return createStatusDetail(false, 'incomplete', 'GPT-SoVITS 运行目录存在，但缺少官方仓库文件。', true);
          }
          if (!fs.existsSync(venvPython)) {
            return createStatusDetail(false, 'missing_runtime', 'GPT-SoVITS 运行目录存在，但缺少独立 Python 运行时。', true);
          }
          if (!fs.existsSync(bootstrapStatePath)) {
            return createStatusDetail(false, 'incomplete', 'GPT-SoVITS 独立运行时目录存在，但依赖安装状态文件缺失。', true);
          }
          if (!fs.existsSync(configPath)) {
            return createStatusDetail(false, 'incomplete', 'GPT-SoVITS 缺少生成后的推理配置文件。', true);
          }
          if (!fs.existsSync(weightsRoot)) {
            return createStatusDetail(false, 'incomplete', 'GPT-SoVITS 缺少预训练模型目录。', true);
          }
          return createStatusDetail(true, 'ready', 'GPT-SoVITS 官方仓库、独立运行时和预训练资源已就绪。');
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
        const qwenTextDetail = getQwenTextModelStatusDetail();
        const indexTtsDetail = getIndexTtsStatusDetail();
        const gptSovitsDetail = getGptSovitsStatusDetail();
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
          gpt_sovits: gptSovitsDetail.installed,
          source_separation: sourceSeparationDetail.installed,
          qwen: qwenTextDetail.installed,
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
          qwen: qwenTextDetail,
          qwen_asr_06b: qwenAsr06BDetail,
          qwen_asr_17b: qwenAsr17BDetail,
          qwen_asr_aligner: qwenAlignerDetail,
          vibevoice_asr_standard: {
            state: vibeVoiceAsrDetail.state,
            detail: vibeVoiceAsrDetail.detail,
            repairable: vibeVoiceAsrDetail.repairable,
          },
          index_tts: indexTtsDetail,
          gpt_sovits: gptSovitsDetail,
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

  ipcMain.handle('list-dir-files', async (_event, dirPath: string) => {
    try {
      if (!dirPath || !fs.existsSync(dirPath)) {
        return [];
      }
      if (!fs.statSync(dirPath).isDirectory()) {
        return [];
      }
      return fs.readdirSync(dirPath, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch (e) {
      logMainError('读取目录文件列表失败', {
        domain: 'filesystem',
        action: 'list-dir-files',
        detail: e instanceof Error ? e.message : String(e)
      })
      return [];
    }
  });


  // IPC Handler to Cancel Download
  // IPC Handler to Cancel Download
  ipcMain.handle('cancel-download', async (_event, args) => {
    const { key, model } = args; // Expect key, fallback to model
    const trackingKey = key || model;

    const proc = activeDownloads.get(trackingKey);
    if (proc) {
      canceledDownloadKeys.add(trackingKey)
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
      downloadTaskSnapshots.set(trackingKey, {
        key: trackingKey,
        active: false,
        phase: 'canceled',
        message: '下载已取消'
      });
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
      canceledDownloadKeys.add(key)
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
      downloadTaskSnapshots.set(key, {
        key,
        active: false,
        phase: 'canceled',
        message: '下载已取消'
      });
      return { success: true };
    }
    return { success: false, error: 'Not found' };
  });

  ipcMain.handle('get-download-task-snapshots', async () => {
    return {
      success: true,
      tasks: getDownloadTaskSnapshots()
    };
  });

  // IPC Handler for Generic File Download (e.g. RIFE ncnn)
  ipcMain.handle('download-file', async (_event, args) => {
    try {
      const { url, urls, targetDir, key, name, outputFileName, baseDir, releaseAsset } = args as {
        url?: string
        urls?: string[]
        targetDir: string
        key?: string
        name: string
        outputFileName?: string
        baseDir?: 'models' | 'project'
        releaseAsset?: GitHubReleaseAssetSpec
      }
      const candidateUrls = Array.from(new Set([
        ...(Array.isArray(urls) ? urls : []),
        ...(url ? [url] : [])
      ].filter((item): item is string => !!item)))

      if (releaseAsset) {
        try {
          const resolvedReleaseUrl = await resolveGitHubReleaseAssetDownloadUrl(releaseAsset)
          if (!candidateUrls.includes(resolvedReleaseUrl)) {
            candidateUrls.unshift(resolvedReleaseUrl)
          }
        } catch (error) {
          logMainWarn('解析 GitHub release 下载地址失败，回退到静态地址', {
            domain: 'download.lifecycle',
            action: 'download-file',
            detail: error instanceof Error ? error.message : String(error)
          })
        }
      }

      if (candidateUrls.length === 0) {
        return { success: false, error: `${name} 缺少可用下载地址` }
      }

      return await new Promise((resolve) => {
        try {
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
        const safe7zaPath = getSevenZipExecutablePath(projectRoot).replace(/\\/g, '\\\\');
        const serializedUrls = JSON.stringify(candidateUrls)
        const script = `
import sys
import os
import urllib.parse
import zipfile
import shutil
import subprocess
import time
import requests

download_urls = ${serializedUrls}
out_dir = r"${safeFinalDir}"
single_file_name = ${JSON.stringify(outputFileName || '')}
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

archive_path = ""
archive_part_path = ""
single_file_path = os.path.join(out_dir, single_file_name) if single_file_name else ""
single_file_part_path = single_file_path + ".part" if single_file_name else ""

try:
    errors = []
    downloaded = False
    for index, current_url in enumerate(download_urls, start=1):
        archive_ext = os.path.splitext(urllib.parse.urlparse(current_url).path)[1].lower() or ".bin"
        archive_path = os.path.join(out_dir, "temp_download" + archive_ext)
        archive_part_path = archive_path + ".part"
        try:
            print(f"PROGRESS:0:尝试下载地址 {index}/{len(download_urls)}", flush=True)
            print(f"Downloading {current_url}...")
            if single_file_name:
                stream_download(current_url, single_file_path, single_file_name)
                print(f"Saved file to {single_file_path}")
            else:
                stream_download(current_url, archive_path, os.path.basename(archive_path))
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
                if os.path.exists(archive_path):
                    os.remove(archive_path)
            downloaded = True
            break
        except Exception as download_error:
            errors.append(f"{current_url} -> {download_error}")
            for leftover_path in (archive_path, archive_part_path, single_file_part_path):
                if leftover_path and os.path.exists(leftover_path):
                    try:
                        os.remove(leftover_path)
                    except OSError:
                        pass
            if index < len(download_urls):
                print(f"PROGRESS:0:当前地址失败，准备切换备用地址 {index + 1}/{len(download_urls)}", flush=True)
    if not downloaded:
        raise RuntimeError("所有下载地址均失败：\\n" + "\\n".join(errors))
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
        if (key) markDownloadTaskStarted(key, `${name} 准备下载`);

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
          const wasCanceled = !!key && canceledDownloadKeys.delete(key);
          if (wasCanceled) {
            resolve({ success: false, canceled: true, error: 'Cancelled' });
            return;
          }
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
            if (key) {
              emitModelDownloadProgress(_event.sender, key, {
                phase: 'failed',
                message: `${name} 下载失败`
              });
            }
            resolve({ success: false, error: `Failed (Code ${code})\n${errorOut}\n${output}` });
          }
        });

      } catch (e: unknown) {
        resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  });

  ipcMain.handle('install-transformers5-asr-runtime', async (_event, args) => {
    return new Promise((resolve) => {
      try {
        const trackingKey = args?.key || 'transformers5_asr_runtime';
        const { projectRoot } = resolveModelsRoot();
        const targetDir = getRuntimeOverlayRoot('transformers5_asr', projectRoot);

        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        const pythonExe = getPythonExe(projectRoot);
        const safeTargetDir = targetDir.replace(/\\/g, '\\\\');
        const script = `
import os
import shutil
import subprocess
import sys

target_dir = r"${safeTargetDir}"
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

emit(100, "共享 Transformers 5.x ASR Runtime 安装完成")
print("SUCCESS", flush=True)
`;

        const proc = spawn(pythonExe, ['-c', script], {
          env: getPythonProcessEnv()
        });

        activeDownloads.set(trackingKey, proc);
        markDownloadTaskStarted(trackingKey, '准备安装共享 Transformers 5.x ASR Runtime', 'installing');
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
          const wasCanceled = canceledDownloadKeys.delete(trackingKey);
          if (wasCanceled) {
            resolve({ success: false, canceled: true, error: 'Cancelled' });
            return;
          }
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
        markDownloadTaskStarted(trackingKey, '准备安装 FunASR Python Runtime', 'installing');
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
          const wasCanceled = canceledDownloadKeys.delete(trackingKey);
          if (wasCanceled) {
            resolve({ success: false, canceled: true, error: 'Cancelled' });
            return;
          }
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
    const resolvedRuntimeRoot = resolveRuntimeRoot(projectRoot).runtimeRoot
    const candidates = app.isPackaged
      ? [
          path.join(resolvedRuntimeRoot, 'python', 'python.exe'),
          path.join(getManagedRuntimeRoot(projectRoot), 'python', 'python.exe'),
          path.join(process.resourcesPath, 'python', 'python.exe'),
          path.join(projectRoot, 'runtime', 'python', 'python.exe'),
          path.join(projectRoot, 'python', 'python.exe')
        ]
      : [
          path.join(resolvedRuntimeRoot, 'python', 'python.exe'),
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
    import sys
    import time
    model_id = '${model}'
    target_dir = '${safeTarget}'
    print(f"Downloading {model_id} to {target_dir}...")
    if model_id.startswith('hf://'):
        import os
        import json
        import requests
        from huggingface_hub import snapshot_download
        repo_id = model_id[len('hf://'):]
        os.environ['HF_HUB_DISABLE_XET'] = '1'
        os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '0'
        max_attempts = 4

        def http_session():
            session = requests.Session()
            adapter = requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=8, max_retries=0)
            session.mount('https://', adapter)
            session.mount('http://', adapter)
            session.headers.update({
                'User-Agent': 'VideoSyncMaster/1.0 (+https://huggingface.co)'
            })
            return session

        def fetch_repo_tree(session):
            base_url = f"https://huggingface.co/api/models/{repo_id}/tree/main"
            params = {'recursive': '1', 'expand': '1'}
            response = session.get(base_url, params=params, timeout=(20, 120))
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list):
                raise RuntimeError(f"官方树接口返回异常：{type(payload).__name__}")
            files = []
            for item in payload:
                if not isinstance(item, dict):
                    continue
                if item.get('type') != 'file':
                    continue
                file_path = item.get('path') or item.get('rfilename') or item.get('name')
                if not file_path:
                    continue
                size = item.get('size')
                try:
                    size = int(size) if size is not None else 0
                except Exception:
                    size = 0
                files.append({'path': str(file_path), 'size': max(size, 0)})
            if not files:
                preview = json.dumps(payload[:2], ensure_ascii=False) if isinstance(payload, list) else str(payload)
                raise RuntimeError(f"官方树接口未返回可下载文件：{preview}")
            return files

        def direct_download_with_manifest():
            session = http_session()
            files = fetch_repo_tree(session)
            total_files = len(files)
            total_bytes = sum(max(int(item.get('size', 0) or 0), 0) for item in files)
            downloaded_bytes = 0
            completed_files = 0
            last_percent = -1
            print(f"PROGRESS:8:已切换到 Hugging Face 官方直链下载，共 {total_files} 个文件", flush=True)

            for item in files:
                file_path = item['path']
                expected_size = max(int(item.get('size', 0) or 0), 0)
                local_path = os.path.join(target_dir, file_path.replace('/', os.sep))
                os.makedirs(os.path.dirname(local_path), exist_ok=True)
                current_size = os.path.getsize(local_path) if os.path.exists(local_path) else 0
                if expected_size > 0 and current_size == expected_size:
                    downloaded_bytes += expected_size
                    completed_files += 1
                    percent = min(99, int(downloaded_bytes * 100 / total_bytes)) if total_bytes > 0 else min(99, int(completed_files * 100 / total_files))
                    if percent != last_percent:
                        print(f"PROGRESS:{percent}:Hugging Face 官方直链校验中（{completed_files}/{total_files} 个文件）", flush=True)
                        last_percent = percent
                    continue

                temp_path = local_path + '.part'
                if os.path.exists(temp_path):
                    os.remove(temp_path)

                download_url = f"https://huggingface.co/{repo_id}/resolve/main/{file_path}"
                file_attempts = 3
                for file_attempt in range(1, file_attempts + 1):
                    try:
                        with session.get(download_url, stream=True, timeout=(20, 300), allow_redirects=True) as response:
                            response.raise_for_status()
                            with open(temp_path, 'wb') as handle:
                                file_downloaded = 0
                                for chunk in response.iter_content(chunk_size=1024 * 1024):
                                    if not chunk:
                                        continue
                                    handle.write(chunk)
                                    file_downloaded += len(chunk)
                                    combined_bytes = downloaded_bytes + file_downloaded
                                    percent = min(99, int(combined_bytes * 100 / total_bytes)) if total_bytes > 0 else min(99, int((completed_files + 1) * 100 / total_files))
                                    if percent != last_percent:
                                        print(f"PROGRESS:{percent}:Hugging Face 官方直链下载中（{completed_files}/{total_files} 个文件，当前 {file_path}）", flush=True)
                                        last_percent = percent
                        final_size = os.path.getsize(temp_path) if os.path.exists(temp_path) else 0
                        if expected_size > 0 and final_size != expected_size:
                            raise RuntimeError(f"{file_path} 文件大小不匹配，期望 {expected_size}，实际 {final_size}")
                        os.replace(temp_path, local_path)
                        downloaded_bytes += final_size if expected_size <= 0 else expected_size
                        completed_files += 1
                        percent = min(99, int(downloaded_bytes * 100 / total_bytes)) if total_bytes > 0 else min(99, int(completed_files * 100 / total_files))
                        print(f"PROGRESS:{percent}:Hugging Face 官方直链已完成 {completed_files}/{total_files} 个文件", flush=True)
                        break
                    except Exception as file_error:
                        if os.path.exists(temp_path):
                            try:
                                os.remove(temp_path)
                            except OSError:
                                pass
                        if file_attempt >= file_attempts:
                            raise RuntimeError(f"{file_path} 直链下载失败，已重试 {file_attempts} 次：{file_error}") from file_error
                        print(f"PROGRESS:{max(5, last_percent)}:文件下载波动，重试 {file_attempt}/{file_attempts}：{file_path}", flush=True)
                        time.sleep(min(4 * file_attempt, 10))

        last_error = None
        for attempt in range(1, max_attempts + 1):
            try:
                print(f"PROGRESS:{min(90, 10 + attempt * 15)}:连接 Hugging Face 官方下载器（第 {attempt}/{max_attempts} 次）", flush=True)
                snapshot_download(
                    repo_id=repo_id,
                    local_dir=target_dir,
                    max_workers=4,
                )
                print("PROGRESS:100:Hugging Face 官方下载完成", flush=True)
                last_error = None
                break
            except Exception as download_error:
                last_error = download_error
                print(f"PROGRESS:{min(95, 10 + attempt * 15)}:官方下载器失败，准备重试 {attempt}/{max_attempts}：{download_error}", flush=True)
                time.sleep(min(5 * attempt, 12))
        if last_error is not None:
            print("PROGRESS:6:官方下载器不可用，切换到 Hugging Face 官方直链模式", flush=True)
            try:
                direct_download_with_manifest()
                print("PROGRESS:100:Hugging Face 官方直链下载完成", flush=True)
                last_error = None
            except Exception as direct_error:
                raise RuntimeError(
                    f"Hugging Face 官方下载失败。官方下载器错误：{last_error}；官方直链错误：{direct_error}"
                ) from direct_error
    else:
        from modelscope.hub.snapshot_download import snapshot_download
        print("PROGRESS:0:准备连接 ModelScope", flush=True)
        snapshot_download(model_id, local_dir=target_dir)
        print("PROGRESS:100:ModelScope 下载完成", flush=True)
    print("SUCCESS", flush=True)
except Exception as e:
    import traceback
    print(f"ERROR: {e}", flush=True)
    traceback.print_exc()
    sys.exit(1)
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
        markDownloadTaskStarted(trackingKey, `${model} 准备下载`);

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
          const wasCanceled = canceledDownloadKeys.delete(trackingKey);
          if (logStream) {
            logStream.write(`\n[${new Date().toISOString()}] [DownloadModel] Finished with code ${code}\n`);
            logStream.end();
          }

          if (wasCanceled) {
            resolve({ success: false, canceled: true, error: 'Cancelled' });
            return;
          }

          if (code === 0 && output.includes('SUCCESS')) {
            emitModelDownloadProgress(_event.sender, trackingKey, {
              percent: 100,
              phase: 'completed',
              message: '下载完成'
            });
            resolve({ success: true });
          } else {
            emitModelDownloadProgress(_event.sender, trackingKey, {
              phase: 'failed',
              message: `${model} 下载失败`
            });
            resolve({ success: false, error: `Process failed (Code ${code}). \n${errorOut}\n${output}` });
          }
        });

      } catch (e: unknown) {
        resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
})
