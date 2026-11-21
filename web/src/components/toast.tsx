import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cx } from './ui.tsx'

export interface ToastInput {
  tone?: 'success' | 'error' | 'info'
  title: string
  message?: string
}
interface ToastItem extends Required<Pick<ToastInput, 'tone' | 'title'>> {
  id: number
  message?: string
}

const ToastContext = createContext<{ push: (t: ToastInput) => void } | null>(null)

/** For code outside React: the query client's global error handler. */
const external = new Set<(t: ToastInput) => void>()
export function emitToast(t: ToastInput) {
  for (const l of external) l(t)
}

const STYLE = {
  success: { icon: CheckCircle2, ring: 'ring-success-200', icn: 'text-success-700' },
  error: { icon: XCircle, ring: 'ring-danger-200', icn: 'text-danger-700' },
  info: { icon: Info, ring: 'ring-info-200', icn: 'text-info-700' },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const next = useRef(1)
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), [])
  const push = useCallback(
    (t: ToastInput) => {
      const id = next.current++
      const tone = t.tone ?? 'info'
      setItems((xs) => [...xs.slice(-3), { id, tone, title: t.title, message: t.message }])
      setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 5000)
    },
    [dismiss],
  )
  const value = useMemo(() => ({ push }), [push])
  useEffect(() => {
    external.add(push)
    return () => {
      external.delete(push)
    }
  }, [push])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => {
          const s = STYLE[t.tone]
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className={cx('pointer-events-auto flex animate-slide-up gap-3 rounded-card bg-white p-3 text-sm shadow-overlay ring-1', s.ring)}
            >
              <s.icon aria-hidden className={cx('mt-0.5 size-4 shrink-0', s.icn)} />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-neutral-900">{t.title}</p>
                {t.message && <p className="mt-0.5 text-neutral-600">{t.message}</p>}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="self-start rounded p-0.5 text-neutral-400 hover:text-neutral-700">
                <X aria-hidden className="size-4" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

/** A no-op outside a provider (isolated tests). */
export function useToast() {
  return useContext(ToastContext) ?? { push: () => {} }
}
