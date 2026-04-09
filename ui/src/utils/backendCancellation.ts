export function isBackendCanceledError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { canceled?: boolean; code?: string; message?: string }
  return candidate.canceled === true || candidate.code === 'BACKEND_CANCELED' || candidate.message === 'Task canceled by user'
}
