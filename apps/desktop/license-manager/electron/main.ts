import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { createPrivateKey, createHash, randomBytes, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

type PlanCycle = 'monthly' | 'quarterly' | 'yearly'
type MachineFingerprintVersion = 'cpu-v1' | 'cpu-short-v1'

interface PlanDefinition {
  id: string
  name: string
  cycle: PlanCycle
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
  cycle: PlanCycle
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
    fingerprintVersion?: MachineFingerprintVersion
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
  fingerprintVersion?: MachineFingerprintVersion
  hostName: string
  platform: string
  arch: string
  appVersion: string
  available?: boolean
  reason?: string
}

const LICENSE_PRODUCT_NAME = 'VideoSyncMaster'
const LICENSE_EDITION_NAME = 'Commercial'
const LICENSING_SCHEMA_VERSION = 1
const LICENSE_VAULT_METADATA_FILE = 'vault-meta.json'
const LICENSE_PUBLIC_KEY_FILE = 'public-key.pem'
const LICENSE_PRIVATE_KEY_FILE = 'private-key.pem'
const LICENSE_ISSUED_DIR = 'issued'
const TRUSTED_LICENSE_PUBLIC_KEY_FINGERPRINT = '04B0BFB1FE9B01E0'
const ACTIVE_MACHINE_FINGERPRINT_VERSION: MachineFingerprintVersion = 'cpu-v1'
const ACTIVATION_CODE_MAGIC = 'VSM2'
const ACTIVATION_CODE_VERSION = 2
const ACTIVATION_CODE_NOTE = 'activation-code-v2'
const BASE32_CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SHORT_DEVICE_CODE_VERSION: MachineFingerprintVersion = 'cpu-short-v1'
const SHORT_DEVICE_CODE_LENGTH = 20
const PLAN_CODE_BY_ID: Record<string, number> = {
  'starter-monthly': 1,
  'starter-quarterly': 2,
  'starter-yearly': 3
}

const LICENSE_PLANS: PlanDefinition[] = [
  {
    id: 'starter-monthly',
    name: '个人月套餐',
    cycle: 'monthly',
    priceCny: 15,
    priceLabel: '15 元 / 月',
    seats: 1,
    description: '适用于轻量日常制作。',
    features: ['单设备授权', '字幕翻译与配音', '标准更新支持']
  },
  {
    id: 'starter-quarterly',
    name: '个人季套餐',
    cycle: 'quarterly',
    priceCny: 39,
    priceLabel: '39 元 / 季',
    seats: 1,
    description: '适用于阶段性交付与连续使用。',
    features: ['单设备授权', '批量任务支持', '标准更新支持']
  },
  {
    id: 'starter-yearly',
    name: '个人年套餐',
    cycle: 'yearly',
    priceCny: 129,
    priceLabel: '129 元 / 年',
    seats: 1,
    description: '适用于长期稳定生产使用。',
    features: ['单设备授权', '批量工作流', '年度更新支持']
  }
]

let win: BrowserWindow | null = null

function ensureDirectorySync(targetPath: string) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true })
  }
}

function getLicensingRoot() {
  return path.join(app.getPath('userData'), 'licensing')
}

function getEmbeddedAuthorityRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'licensing-authority')
    : path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'), '../../../resources/licensing-authority')
}

function getLicenseIssuedDir() {
  return path.join(getLicensingRoot(), LICENSE_ISSUED_DIR)
}

function getLicenseVaultMetadataPath() {
  return path.join(getEmbeddedAuthorityRoot(), LICENSE_VAULT_METADATA_FILE)
}

function getLicensePublicKeyPath() {
  return path.join(getEmbeddedAuthorityRoot(), LICENSE_PUBLIC_KEY_FILE)
}

function getLicensePrivateKeyPath() {
  return path.join(getEmbeddedAuthorityRoot(), LICENSE_PRIVATE_KEY_FILE)
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

function isCanonicalShortDeviceCode(value: unknown) {
  return typeof value === 'string' && /^[0-9A-HJKMNPQRSTVWXYZ]{20}$/i.test(value.trim())
}

function buildMachineFingerprintInfo() {
  const primaryCpu = os.cpus()?.[0]
  const cpuModel = normalizeMachineToken(primaryCpu?.model) || 'UNKNOWN-CPU'
  const cpuCount = String(os.cpus()?.length || 1)
  const hostName = os.hostname() || process.env.COMPUTERNAME || 'unknown-host'
  const raw = [
    LICENSE_PRODUCT_NAME,
    ACTIVE_MACHINE_FINGERPRINT_VERSION,
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
    fingerprintVersion: ACTIVE_MACHINE_FINGERPRINT_VERSION,
    hostName,
    platform: os.platform(),
    arch: os.arch(),
    appVersion: app.getVersion()
  }
}

function buildUnavailableMachineFingerprintInfo(reason?: string): MachineFingerprintInfoRecord {
  return {
    shortFingerprint: 'UNAVAILABLE',
    hostName: os.hostname() || process.env.COMPUTERNAME || 'unknown-host',
    platform: os.platform(),
    arch: os.arch(),
    appVersion: app.getVersion(),
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
    return buildUnavailableMachineFingerprintInfo(error instanceof Error ? error.message : String(error))
  }
}

function computePublicKeyFingerprint(publicKeyPem: string) {
  return createHash('sha256').update(publicKeyPem.trim()).digest('hex').slice(0, 16).toUpperCase()
}

function hexToBytes(hex: string) {
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

function encodeAsciiBytes(value: string) {
  return Uint8Array.from(Buffer.from(value, 'ascii'))
}

function encodeUint32(value: number) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32BE(value >>> 0, 0)
  return Uint8Array.from(buffer)
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

function formatActivationCodeForDisplay(value: string, groupSize = 24) {
  const normalized = value.replace(/[^0-9A-Z]/gi, '').toUpperCase()
  if (!normalized) return ''
  return normalized.match(new RegExp(`.{1,${groupSize}}`, 'g'))?.join('-') || normalized
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

  const bindingVersion = payload.deviceBinding?.fingerprintVersion || ACTIVE_MACHINE_FINGERPRINT_VERSION
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

function verifyLicenseEnvelopeSignature(envelope: LicenseEnvelopeRecord, publicKeyPem: string) {
  const message = envelope.payload.notes === ACTIVATION_CODE_NOTE
    ? Buffer.from(buildCompactLicensePayloadBytes(envelope.payload, envelope.keyFingerprint))
    : Buffer.from(canonicalizeForSigning(envelope.payload))

  return cryptoVerify(
    null,
    message,
    publicKeyPem,
    Buffer.from(envelope.signature, 'base64')
  )
}

function validateEmbeddedAuthority() {
  const publicKeyPath = getLicensePublicKeyPath()
  const privateKeyPath = getLicensePrivateKeyPath()
  const metadataPath = getLicenseVaultMetadataPath()

  if (!fs.existsSync(publicKeyPath) || !fs.existsSync(privateKeyPath) || !fs.existsSync(metadataPath)) {
    throw new Error('未检测到内置授权机构密钥。')
  }

  const publicKeyPem = fs.readFileSync(publicKeyPath, 'utf8')
  const fingerprint = computePublicKeyFingerprint(publicKeyPem)
  if (fingerprint !== TRUSTED_LICENSE_PUBLIC_KEY_FINGERPRINT) {
    throw new Error('授权机构公钥指纹不匹配，已拒绝加载。')
  }

  return {
    publicKeyPem,
    fingerprint
  }
}

function readLicenseVaultMetadata() {
  const metadataPath = getLicenseVaultMetadataPath()
  if (!fs.existsSync(metadataPath)) {
    return null
  }

  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { initializedAt?: string; publicKeyFingerprint?: string }
  } catch {
    return null
  }
}

function readLatestIssuedLicense(): LicenseEnvelopeRecord | undefined {
  const issuedDir = getLicenseIssuedDir()
  if (!fs.existsSync(issuedDir)) {
    return undefined
  }

  const files = fs.readdirSync(issuedDir)
    .filter((item) => item.toLowerCase().endsWith('.license.json'))
    .map((item) => ({
      file: item,
      mtime: fs.statSync(path.join(issuedDir, item)).mtimeMs
    }))
    .sort((left, right) => right.mtime - left.mtime)

  if (files.length === 0) {
    return undefined
  }

  try {
    return JSON.parse(fs.readFileSync(path.join(issuedDir, files[0].file), 'utf8')) as LicenseEnvelopeRecord
  } catch {
    return undefined
  }
}

function getLicenseVaultStatus() {
  ensureDirectorySync(getLicenseIssuedDir())

  let authorityReady = false
  const metadata = readLicenseVaultMetadata()
  const publicKeyPath = getLicensePublicKeyPath()
  const privateKeyPath = getLicensePrivateKeyPath()
  let fingerprint: string | undefined = metadata?.publicKeyFingerprint

  try {
    const authority = validateEmbeddedAuthority()
    authorityReady = true
    fingerprint = authority.fingerprint
  } catch {
    authorityReady = false
  }

  const issuedLicenseCount = fs.existsSync(getLicenseIssuedDir())
    ? fs.readdirSync(getLicenseIssuedDir()).filter((item) => item.toLowerCase().endsWith('.license.json')).length
    : 0

  return {
    initialized: authorityReady,
    publicKeyFingerprint: fingerprint,
    publicKeyPath,
    privateKeyPath,
    issuedLicenseCount,
    initializedAt: metadata?.initializedAt
  }
}

function buildLicensingOverview() {
  const machine = getMachineFingerprintInfoSafe()
  return {
    success: true,
    plans: LICENSE_PLANS,
    machine,
    keyVault: getLicenseVaultStatus(),
    vaultPath: getLicensingRoot(),
    latestIssuedLicense: readLatestIssuedLicense(),
    error: machine.available === false ? machine.reason : undefined
  }
}

function encodeLicenseEnvelope(licenseEnvelope: LicenseEnvelopeRecord) {
  const compactBytes = buildCompactLicensePayloadBytes(licenseEnvelope.payload, licenseEnvelope.keyFingerprint)
  const signatureBytes = Buffer.from(licenseEnvelope.signature, 'base64')
  if (signatureBytes.length !== 64) {
    throw new Error('许可证签名长度无效。')
  }
  return formatActivationCodeForDisplay(encodeBase32Crockford(concatBytes(compactBytes, Uint8Array.from(signatureBytes))))
}

function buildValidityWindow(plan: PlanDefinition) {
  const validFrom = new Date()
  const validUntil = new Date(validFrom)
  if (plan.cycle === 'yearly') {
    validUntil.setDate(validUntil.getDate() + 365)
  } else if (plan.cycle === 'quarterly') {
    validUntil.setDate(validUntil.getDate() + 90)
  } else {
    validUntil.setDate(validUntil.getDate() + 30)
  }
  return { validFrom, validUntil }
}

function issueLicenseCode(payload: {
  deviceCode: string
  planId: string
}) {
  const plan = LICENSE_PLANS.find((item) => item.id === payload.planId)
  if (!plan) {
    return { success: false, error: '未找到对应套餐定义。' }
  }

  const deviceCode = String(payload.deviceCode || '').trim().toUpperCase()
  if (!deviceCode) {
    return { success: false, error: '设备识别码不能为空。' }
  }
  if (!isCanonicalShortDeviceCode(deviceCode)) {
    return { success: false, error: '设备识别码格式无效。请使用客户端复制的短设备码。' }
  }
  const { validFrom, validUntil } = buildValidityWindow(plan)

  if (!fs.existsSync(getLicensePrivateKeyPath()) || !fs.existsSync(getLicensePublicKeyPath())) {
    return { success: false, error: '请先初始化授权密钥仓。' }
  }

  const privateKeyPem = fs.readFileSync(getLicensePrivateKeyPath(), 'utf8')
  const { publicKeyPem, fingerprint } = validateEmbeddedAuthority()
  const privateKey = createPrivateKey({
    key: privateKeyPem,
    format: 'pem',
    type: 'pkcs8'
  })

  const licensePayload: LicensePayloadRecord = {
    schemaVersion: LICENSING_SCHEMA_VERSION,
    licenseId: `LIC-${randomBytes(6).toString('hex').toUpperCase()}`,
    product: LICENSE_PRODUCT_NAME,
    edition: LICENSE_EDITION_NAME,
    customerName: deviceCode,
    customerEmail: 'activation@local',
    planId: plan.id,
    planName: plan.name,
    cycle: plan.cycle,
    priceCny: plan.priceCny,
    currency: 'CNY',
    issuedAt: new Date().toISOString(),
    validFrom: validFrom.toISOString(),
    validUntil: validUntil.toISOString(),
    maxDevices: 1,
    features: plan.features,
    operator: 'RRQ-DS',
    status: 'active',
    notes: ACTIVATION_CODE_NOTE,
    deviceBinding: {
      mode: 'required',
      fingerprint: deviceCode,
      fingerprintVersion: SHORT_DEVICE_CODE_VERSION,
      label: deviceCode
    }
  }

  const compactPayloadBytes = buildCompactLicensePayloadBytes(licensePayload, fingerprint)
  const signature = cryptoSign(null, Buffer.from(compactPayloadBytes), privateKey).toString('base64')

  const licenseEnvelope: LicenseEnvelopeRecord = {
    signatureAlgorithm: 'ed25519',
    keyFingerprint: fingerprint,
    payload: licensePayload,
    signature
  }

  const verified = verifyLicenseEnvelopeSignature(licenseEnvelope, publicKeyPem)

  if (!verified) {
    return { success: false, error: '许可证本地复验失败，已拒绝导出。' }
  }

  const issuedArchivePath = path.join(getLicenseIssuedDir(), `${licensePayload.licenseId}.license.json`)
  fs.writeFileSync(issuedArchivePath, JSON.stringify(licenseEnvelope, null, 2), 'utf8')

  return {
    success: true,
    activationCode: encodeLicenseEnvelope(licenseEnvelope),
    license: licenseEnvelope,
    archivePath: issuedArchivePath
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1120,
    minHeight: 700,
    frame: false,
    backgroundColor: '#08111f',
    icon: path.join(process.env.VITE_PUBLIC || '', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
    },
    autoHideMenuBar: true
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

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
  return win?.isMaximized() ?? false
})

ipcMain.handle('dialog:openFile', async (_event, options) => {
  const target = BrowserWindow.fromWebContents(_event.sender) || win || undefined
  if (target) {
    return dialog.showOpenDialog(target, options as Electron.OpenDialogOptions)
  }
  return dialog.showOpenDialog(options as Electron.OpenDialogOptions)
})

ipcMain.handle('dialog:showSaveDialog', async (_event, options) => {
  const target = BrowserWindow.fromWebContents(_event.sender) || win || undefined
  if (target) {
    return dialog.showSaveDialog(target, options as Electron.SaveDialogOptions)
  }
  return dialog.showSaveDialog(options as Electron.SaveDialogOptions)
})

ipcMain.handle('get-licensing-overview', async () => {
  try {
    return buildLicensingOverview()
  } catch (error) {
    return {
      success: false,
      plans: LICENSE_PLANS,
      machine: buildUnavailableMachineFingerprintInfo(error instanceof Error ? error.message : String(error)),
      keyVault: getLicenseVaultStatus(),
      vaultPath: getLicensingRoot(),
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('issue-license', async (_event, payload) => {
  void _event
  try {
    return issueLicenseCode({
      deviceCode: String(payload?.deviceCode || ''),
      planId: String(payload?.planId || '')
    })
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('open-external', async (_event, target: string) => {
  void _event
  if (!target) return false
  await shell.openExternal(target)
  return true
})
