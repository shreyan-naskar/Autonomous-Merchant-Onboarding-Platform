import { createContext, useContext } from 'react'

export interface ToastInput {
  tone?: 'success' | 'error' | 'info'
  title: string
  message?: string
}

export const ToastContext = createContext<{ push: (t: ToastInput) => void } | null>(null)

/** For code outside React: the query client's global error handler. */
export const externalToastListeners = new Set<(t: ToastInput) => void>()
export function emitToast(t: ToastInput) {
  for (const l of externalToastListeners) l(t)
}

/** A no-op outside a provider (isolated tests). */
export function useToast() {
  return useContext(ToastContext) ?? { push: () => {} }
}
