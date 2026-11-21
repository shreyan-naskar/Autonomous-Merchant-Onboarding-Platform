/* Design-system primitives. Only token colors (index.css); status is never shown by color alone. */
import { AlertTriangle, Check, CheckCircle2, ChevronRight, Copy, Info, Loader2, X, XCircle, type LucideIcon } from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { friendlyError } from '../lib/api.ts'
import { usePageTitle } from '../lib/pageTitle.tsx'

export type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export const TONE_SOFT: Record<Tone, string> = {
  accent: 'bg-accent-50 text-accent-800 ring-accent-200',
  success: 'bg-success-50 text-success-800 ring-success-200',
  warning: 'bg-warning-50 text-warning-800 ring-warning-200',
  danger: 'bg-danger-50 text-danger-800 ring-danger-200',
  info: 'bg-info-50 text-info-800 ring-info-200',
  neutral: 'bg-neutral-100 text-neutral-700 ring-neutral-200',
}
export const TONE_DOT: Record<Tone, string> = {
  accent: 'bg-accent-600',
  success: 'bg-success-600',
  warning: 'bg-warning-500',
  danger: 'bg-danger-600',
  info: 'bg-info-600',
  neutral: 'bg-neutral-400',
}
const TONE_ICON: Record<Tone, LucideIcon> = {
  accent: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
  neutral: Info,
}


type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-accent-700 text-white hover:bg-accent-800 shadow-sm',
  secondary: 'bg-white text-neutral-800 ring-1 ring-inset ring-neutral-300 hover:bg-neutral-50 shadow-sm',
  danger: 'bg-danger-700 text-white hover:bg-danger-800 shadow-sm',
  ghost: 'text-neutral-700 hover:bg-neutral-100',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: LucideIcon
  loading?: boolean
}

export function Button({ variant = 'secondary', size = 'md', icon: Icon, loading, disabled, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        BUTTON[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : Icon ? <Icon aria-hidden className="size-4" /> : null}
      {children}
    </button>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <Loader2 role="status" aria-label={label} className="size-4 animate-spin text-neutral-400" />
}


interface FieldChrome {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  hideLabel?: boolean
  required?: boolean
}

function FieldShell({ id, label, hint, error, hideLabel, required, children }: FieldChrome & { id: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={cx('block text-xs font-medium text-neutral-700', hideLabel && 'sr-only')}>
        {label}
        {required && <span className="text-danger-700"> *</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-1 text-xs text-danger-700">
          <XCircle aria-hidden className="size-3.5 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-neutral-500">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

const control = (error?: string | null) =>
  cx(
    'block w-full rounded-control border bg-white px-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 shadow-xs transition-colors',
    'focus:border-accent-600 focus:outline-none focus:ring-2 focus:ring-accent-600/20 disabled:bg-neutral-100 disabled:text-neutral-500',
    error ? 'border-danger-500' : 'border-neutral-300',
  )

function useFieldIds(id: string | undefined, error?: string | null, hint?: ReactNode) {
  const auto = useId()
  const fieldId = id ?? auto
  return {
    id: fieldId,
    describedBy: error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined,
  }
}

export function Input({ label, hint, error, hideLabel, required, id, className, ...rest }: FieldChrome & InputHTMLAttributes<HTMLInputElement>) {
  const ids = useFieldIds(id, error, hint)
  return (
    <FieldShell id={ids.id} label={label} hint={hint} error={error} hideLabel={hideLabel} required={required}>
      <input
        id={ids.id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        className={cx(control(error), 'h-9', className)}
        {...rest}
      />
    </FieldShell>
  )
}

export function Textarea({ label, hint, error, hideLabel, required, id, className, ...rest }: FieldChrome & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ids = useFieldIds(id, error, hint)
  return (
    <FieldShell id={ids.id} label={label} hint={hint} error={error} hideLabel={hideLabel} required={required}>
      <textarea
        id={ids.id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        className={cx(control(error), 'py-2', className)}
        {...rest}
      />
    </FieldShell>
  )
}

export function Select({ label, hint, error, hideLabel, required, id, className, children, ...rest }: FieldChrome & SelectHTMLAttributes<HTMLSelectElement>) {
  const ids = useFieldIds(id, error, hint)
  return (
    <FieldShell id={ids.id} label={label} hint={hint} error={error} hideLabel={hideLabel} required={required}>
      <select
        id={ids.id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        className={cx(control(error), 'h-9 pr-8', className)}
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  )
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div id={`${id}-l`} className="text-sm font-medium text-neutral-900">
          {label}
        </div>
        {description && (
          <div id={`${id}-d`} className="mt-0.5 text-xs text-neutral-500">
            {description}
          </div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={description ? `${id}-d` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-danger-600' : 'bg-neutral-300',
        )}
      >
        <span className={cx('inline-block size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5.5' : 'translate-x-0.5')} />
        <span className="sr-only">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>
  )
}


export function Card({
  title,
  subtitle,
  actions,
  children,
  padded = true,
  className,
  id,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  padded?: boolean
  className?: string
  id?: string
}) {
  return (
    <section id={id} className={cx('rounded-card border border-neutral-200 bg-white shadow-card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>}
            {subtitle && <p className="text-xs text-neutral-500">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
    </section>
  )
}

export function Badge({ tone = 'neutral', icon: Icon, children, className, title }: { tone?: Tone; icon?: LucideIcon; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', TONE_SOFT[tone], className)}>
      {Icon && <Icon aria-hidden className="size-3.5" />}
      {children}
    </span>
  )
}

export function Alert({ tone = 'info', title, children, action }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = TONE_ICON[tone]
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('flex gap-3 rounded-card px-3.5 py-3 text-sm ring-1 ring-inset', TONE_SOFT[tone])}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : undefined}>{children}</div>}
      </div>
      {action}
    </div>
  )
}

export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null
  const f = friendlyError(error)
  return (
    <Alert tone="danger" title={title ?? f.title}>
      {f.message}
      {f.raw && f.raw !== f.message && (
        <Tooltip content={f.raw}>
          <span tabIndex={0} className="ml-1 cursor-help text-xs underline decoration-dotted">
            details
          </span>
        </Tooltip>
      )}
    </Alert>
  )
}

export function StatCard({ label, value, hint, icon: Icon, tone = 'neutral' }: { label: string; value: ReactNode; hint?: ReactNode; icon?: LucideIcon; tone?: Tone }) {
  return (
    <div className="rounded-card border border-neutral-200 bg-white p-4 shadow-card">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-500">{label}</span>
        {Icon && (
          <span className={cx('rounded-md p-1.5 ring-1 ring-inset', TONE_SOFT[tone])}>
            <Icon aria-hidden className="size-4" />
          </span>
        )}
      </div>
      <div className="tabular mt-2 text-2xl font-semibold text-neutral-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-neutral-500">{hint}</div>}
    </div>
  )
}


export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded-md bg-neutral-200/70', className)} />
}

export function SkeletonRows({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-4 w-1/6" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  )
}

export function EmptyState({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <span className="rounded-full bg-neutral-100 p-3 text-neutral-500">
        <Icon aria-hidden className="size-6" />
      </span>
      <h3 className="mt-3 text-sm font-semibold text-neutral-900">{title}</h3>
      {text && <p className="mt-1 max-w-sm text-sm text-neutral-500">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}


export function Tooltip({ content, children, side = 'top', className }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom'; className?: string }) {
  const id = useId()
  return (
    <span className={cx('group/tt relative', className ?? 'inline-flex')} aria-describedby={id}>
      {children}
      <span
        role="tooltip"
        id={id}
        className={cx(
          // display:none until shown, so hidden tooltips never widen the page (phones).
          'pointer-events-none absolute left-1/2 z-50 hidden w-max max-w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 animate-fade-in rounded-md bg-neutral-900 px-2 py-1 text-xs font-normal text-white shadow-overlay',
          'group-hover/tt:block group-focus-within/tt:block',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {content}
      </span>
    </span>
  )
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }}
      className="inline-flex items-center rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
    >
      {done ? <Check aria-hidden className="size-4 text-success-700" /> : <Copy aria-hidden className="size-4" />}
    </button>
  )
}


export interface TabDef<T extends string> {
  id: T
  label: ReactNode
  count?: number
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: readonly TabDef<T>[]; value: T; onChange: (id: T) => void; label: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const onKey = (e: KeyboardEvent, i: number) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!delta) return
    e.preventDefault()
    const next = tabs[(i + delta + tabs.length) % tabs.length]!
    onChange(next.id)
    refs.current[next.id]?.focus()
  }
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-neutral-200">
      {tabs.map((t, i) => {
        const selected = t.id === value
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el
            }}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
              selected ? 'border-accent-700 text-accent-800' : 'border-transparent text-neutral-500 hover:text-neutral-800',
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="tabular rounded-full bg-neutral-100 px-1.5 text-2xs text-neutral-600">{t.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0} className="pt-4 focus:outline-none">
      {children}
    </div>
  )
}


const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descId = useId()

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const el = panel.current
    const first = (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE)) || el
    first?.focus()
    return () => previous?.focus?.()
  }, [open])

  if (!open) return null

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !panel.current) return
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (items.length === 0) return
    const first = items[0]!
    const last = items[items.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 animate-fade-in bg-neutral-900/40" aria-hidden onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className="relative w-full max-w-lg animate-slide-up rounded-card bg-white shadow-overlay focus:outline-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-neutral-100 px-5 py-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-neutral-900">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-sm text-neutral-500">
                {description}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700">
            <X aria-hidden className="size-4" />
          </button>
        </div>
        {children && <div className="space-y-4 px-5 py-4">{children}</div>}
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-neutral-100 bg-neutral-50 px-5 py-3 rounded-b-card">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}


export interface Crumb {
  label: string
  to?: string
}

export function PageHeader({ title, subtitle, actions, breadcrumbs, docTitle }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumbs?: Crumb[]; docTitle?: string }) {
  usePageTitle(docTitle ?? (typeof title === 'string' ? title : 'Merchant Onboarding'))
  return (
    <div className="mb-5 space-y-2">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-neutral-500">
            {breadcrumbs.map((b, i) => (
              <li key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight aria-hidden className="size-3.5 text-neutral-400" />}
                {b.to ? (
                  <Link to={b.to} className="hover:text-neutral-800 hover:underline">
                    {b.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="text-neutral-700">
                    {b.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">{title}</h1>
          {subtitle && <div className="mt-1 text-sm text-neutral-500">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
