import { reportReachable } from './connection.ts'
import { ERRORS } from '../copy.ts'

/** Every failure becomes an ApiError with a `kind`; pages use kind, fieldErrors() and friendlyError(), never message strings. */

type ApiErrorKind = 'network' | 'validation' | 'not_found' | 'conflict' | 'server' | 'client'

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: unknown
  readonly kind: ApiErrorKind
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.kind =
      status === 0
        ? 'network'
        : status === 400 && code === 'VALIDATION_FAILED'
          ? 'validation'
          : status === 404
            ? 'not_found'
            : status === 409
              ? 'conflict'
              : status >= 500
                ? 'server'
                : 'client'
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError
export const isNotFound = (e: unknown) => isApiError(e) && e.kind === 'not_found'
export const isServerError = (e: unknown) => isApiError(e) && e.kind === 'server'
export const isNetworkError = (e: unknown) => isApiError(e) && e.kind === 'network'

type ErrorBody = { error?: { code?: string; message?: string; details?: unknown } }

async function request<T>(base: string, path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...rest,
      headers: json === undefined ? rest.headers : { 'content-type': 'application/json', ...rest.headers },
      body: json === undefined ? rest.body : JSON.stringify(json),
    })
  } catch {
    // fetch only throws when no HTTP answer arrived at all (server down, proxy refused).
    if (base === '/api') reportReachable(false)
    throw new ApiError("Can't reach the server", 0, 'NETWORK')
  }
  // The Vite proxy answers 502/504 itself when the API is down.
  const proxyDown = (res.status === 502 || res.status === 504) && !res.headers.get('content-type')?.includes('json')
  if (base === '/api') reportReachable(!proxyDown)
  if (proxyDown) throw new ApiError("Can't reach the server", 0, 'NETWORK')

  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const b = (body ?? {}) as ErrorBody
    throw new ApiError(b.error?.message ?? `${res.status} ${res.statusText}`, res.status, b.error?.code, b.error?.details)
  }
  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>('/api', path),
  post: <T>(path: string, json?: unknown) => request<T>('/api', path, { method: 'POST', json }),
  patch: <T>(path: string, json: unknown) => request<T>('/api', path, { method: 'PATCH', json }),
  postForm: <T>(path: string, form: FormData) => request<T>('/api', path, { method: 'POST', body: form }),
  patchForm: <T>(path: string, form: FormData) => request<T>('/api', path, { method: 'PATCH', body: form }),
}

export const mockApi = {
  get: <T>(path: string) => request<T>('/mock', path),
  post: <T>(path: string, json?: unknown) => request<T>('/mock', path, { method: 'POST', json }),
}

export function fieldErrors(error: unknown): Record<string, string> {
  if (!isApiError(error) || error.kind !== 'validation' || !Array.isArray(error.details)) return {}
  const out: Record<string, string> = {}
  for (const d of error.details as { path?: string; message?: string }[]) {
    if (d.path && d.message && !out[d.path]) out[d.path] = d.message
  }
  return out
}

interface FriendlyError {
  title: string
  message: string
  /** The API's own text, for a tooltip, when the friendly wording differs. */
  raw?: string
}

export function friendlyError(error: unknown): FriendlyError {
  if (!isApiError(error)) {
    return { title: ERRORS.generic, message: error instanceof Error ? error.message : String(error) }
  }
  switch (error.kind) {
    case 'network':
      return { title: ERRORS.networkTitle, message: ERRORS.networkText }
    case 'server':
      return { title: ERRORS.serverTitle, message: ERRORS.serverMessage, raw: error.message }
    case 'not_found':
      return { title: ERRORS.notFound, message: error.message }
    case 'validation': {
      const fields = Object.entries(fieldErrors(error))
      return {
        title: ERRORS.validationTitle,
        message: fields.length ? fields.map(([f, m]) => `${f}: ${m}`).join(' · ') : error.message,
      }
    }
    case 'conflict': {
      if (error.code === 'GUARD_FAILED') {
        const d = (error.details ?? {}) as { missing?: string[]; checks?: Record<string, string>; bankVersion?: number }
        const parts = (d.missing ?? []).map((k) => {
          const state = ERRORS.checkState[d.checks?.[k] ?? 'MISSING'] ?? 'not passed'
          const label = ERRORS.checkName[k] ?? k
          return k === 'BANK' && d.bankVersion && d.bankVersion > 1 ? `${label} verification (${ERRORS.newBank}) ${state}` : `${label} verification ${state}`
        })
        return {
          title: parts.length ? ERRORS.approveBlocked(parts) : ERRORS.approveTitle,
          message: ERRORS.approveRule,
          raw: error.message,
        }
      }
      if (error.code === 'ILLEGAL_TRANSITION') {
        return { title: ERRORS.conflictTitle, message: error.message, raw: error.message }
      }
      return { title: ERRORS.conflictTitle, message: error.message }
    }
    default:
      return { title: ERRORS.rejectedTitle, message: error.message }
  }
}
