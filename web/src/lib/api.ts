/**
 * Thin fetch wrappers. The browser calls Vite's proxy: `/api` -> API (:3000),
 * `/mock` -> mock providers (:4000). Errors carry the API's readable message
 * (e.g. the 409 approval-guard text) so pages can show it inline.
 */

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: unknown
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

type ErrorBody = { error?: { code?: string; message?: string; details?: unknown } }

/** Zod validation details -> "note: Note is required ..." lines. */
function describe(body: ErrorBody, fallback: string): string {
  const err = body.error
  if (!err) return fallback
  if (err.code === 'VALIDATION_FAILED' && Array.isArray(err.details)) {
    const lines = (err.details as { path: string; message: string }[]).map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
    return `${err.message}: ${lines.join('; ')}`
  }
  return err.message ?? fallback
}

async function request<T>(base: string, path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  const res = await fetch(`${base}${path}`, {
    ...rest,
    headers: json === undefined ? rest.headers : { 'content-type': 'application/json', ...rest.headers },
    body: json === undefined ? rest.body : JSON.stringify(json),
  })
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) {
    const b = (body ?? {}) as ErrorBody
    throw new ApiError(describe(b, `${res.status} ${res.statusText}`), res.status, b.error?.code, b.error?.details)
  }
  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>('/api', path),
  post: <T>(path: string, json?: unknown) => request<T>('/api', path, { method: 'POST', json }),
  patch: <T>(path: string, json: unknown) => request<T>('/api', path, { method: 'PATCH', json }),
  /** multipart/form-data (the browser sets the boundary header). */
  postForm: <T>(path: string, form: FormData) => request<T>('/api', path, { method: 'POST', body: form }),
  patchForm: <T>(path: string, form: FormData) => request<T>('/api', path, { method: 'PATCH', body: form }),
}

export const mockApi = {
  get: <T>(path: string) => request<T>('/mock', path),
  post: <T>(path: string, json?: unknown) => request<T>('/mock', path, { method: 'POST', json }),
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
