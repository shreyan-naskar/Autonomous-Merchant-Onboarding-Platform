/* en-IN formatting: times in IST, Indian digit grouping. */

const LOCALE = 'en-IN'
const ZONE = 'Asia/Kolkata'

/**
 * The one duration format in the UI: "0.5s", "2s", "45s",
 * "2m 14s", "2h 5m", "3d 4h". Tenths of a second below 10s, never "ms".
 */
export function duration(ms: number): string {
  if (ms <= 0) return '0s'
  if (ms < 10_000) return `${Math.max(1, Math.round(ms / 100)) / 10}s`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' })

/** "just now", "3 min ago", "2 hours ago", "yesterday". */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000
  const abs = Math.abs(diff)
  if (abs < 10) return 'just now'
  if (abs < 60) return rtf.format(Math.round(diff), 'second')
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  return rtf.format(Math.round(diff / 86400), 'day')
}

const parts = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  Object.fromEntries(new Intl.DateTimeFormat(LOCALE, { timeZone: ZONE, hourCycle: 'h23', ...opts }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]))

/** "21 Nov 2026, 14:05 IST". */
export function dateTime(iso: string): string {
  const p = parts(iso, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} IST`
}

/** "14:05:32" (IST). */
export function time(iso: string): string {
  const p = parts(iso, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return `${p.hour}:${p.minute}:${p.second}`
}

/** Indian digit grouping: 1,00,000. */
export const count = (n: number) => n.toLocaleString(LOCALE)

/** A count with its noun: "1 exception", "3 exceptions", "1,200 attempts". */
export const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`
