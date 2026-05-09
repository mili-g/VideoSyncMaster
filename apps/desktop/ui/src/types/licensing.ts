export type PlanCycle = 'monthly' | 'quarterly' | 'yearly';

export interface PlanDefinition {
    id: string;
    name: string;
    cycle: PlanCycle;
    priceCny: number;
    priceLabel: string;
    seats: number;
    description: string;
    features: string[];
}

export interface MachineFingerprintInfo {
    fingerprint?: string;
    shortFingerprint: string;
    appVersion: string;
    available?: boolean;
    reason?: string;
}

export interface ActiveLicenseStatus {
    exists: boolean;
    verified: boolean;
    validNow: boolean;
    reason?: string;
    importedAt?: string;
    planId?: string;
    planName?: string;
    cycle?: PlanCycle;
    validFrom?: string;
    validUntil?: string;
    maxDevices?: number;
}

export interface LicensingOverviewResponse {
    success: boolean;
    plans: PlanDefinition[];
    machine: MachineFingerprintInfo;
    activeLicense: ActiveLicenseStatus;
    error?: string;
}

export interface ActivateLicenseResponse {
    success: boolean;
    activeLicense?: ActiveLicenseStatus;
    error?: string;
}
