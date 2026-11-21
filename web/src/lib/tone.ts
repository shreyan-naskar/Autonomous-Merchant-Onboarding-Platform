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
