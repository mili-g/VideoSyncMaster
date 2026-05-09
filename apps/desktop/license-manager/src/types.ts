export type PlanCycle = 'monthly' | 'quarterly' | 'yearly'

export interface PlanDefinition {
  id: string
  name: string
  cycle: PlanCycle
  priceCny: number
  priceLabel: string
  seats: number
  description: string
  features: string[]
}

export interface MachineFingerprintInfo {
  fingerprint?: string
  shortFingerprint: string
  fingerprintVersion?: 'cpu-v1' | 'cpu-short-v1'
  hostName: string
  platform: string
  arch: string
  appVersion: string
  available?: boolean
  reason?: string
}

export interface LicensePayload {
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
    fingerprintVersion?: 'cpu-v1' | 'cpu-short-v1'
    label?: string
  }
}

export interface LicenseEnvelope {
  signatureAlgorithm: 'ed25519'
  keyFingerprint: string
  payload: LicensePayload
  signature: string
}

export interface KeyVaultStatus {
  initialized: boolean
  publicKeyFingerprint?: string
  publicKeyPath?: string
  privateKeyPath?: string
  issuedLicenseCount: number
  initializedAt?: string
}

export interface LicensingOverviewResponse {
  success: boolean
  plans: PlanDefinition[]
  machine: MachineFingerprintInfo
  keyVault: KeyVaultStatus
  vaultPath: string
  latestIssuedLicense?: LicenseEnvelope
  error?: string
}

export interface InitializeLicenseVaultResponse {
  success: boolean
  keyVault?: KeyVaultStatus
  error?: string
}

export interface IssueLicensePayload {
  deviceCode: string
  planId: string
}

export interface IssueLicenseResponse {
  success: boolean
  activationCode?: string
  license?: LicenseEnvelope
  archivePath?: string
  error?: string
}
