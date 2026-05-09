/// <reference types="vite/client" />

import type { IssueLicensePayload, IssueLicenseResponse, LicensingOverviewResponse } from './types'

declare global {
  interface DesktopApi {
    getLicensingOverview(): Promise<LicensingOverviewResponse>
    issueLicense(payload: IssueLicensePayload): Promise<IssueLicenseResponse>
    minimizeWindow(): Promise<boolean>
    toggleMaximizeWindow(): Promise<boolean>
    closeWindow(): Promise<boolean>
    isWindowMaximized(): Promise<boolean>
  }

  interface Window {
    api: DesktopApi
    ipcRenderer: {
      on: (...args: unknown[]) => unknown
      off: (...args: unknown[]) => unknown
      send: (...args: unknown[]) => unknown
      invoke: <T = unknown>(...args: unknown[]) => Promise<T>
    }
  }
}

export {}
