import { APPLICATION_STATUSES, STATUS_LABELS, type ApplicationStatus } from '@app/shared'
import { Activity, AlertTriangle, CheckCircle2, Timer } from 'lucide-react'
import { STATUS_ICON, toneOf } from '../lib/status.ts'
import { METRICS as C } from '../copy.ts'
import { count, duration } from '../lib/format.ts'
import { useMetrics } from '../lib/queries.ts'
import { Skeleton, StatCard, Tooltip } from './ui.tsx'
import { TONE_SOFT, cx } from '../lib/tone.ts'

const TIMED: readonly ApplicationStatus[] = ['EXTRACTING', 'VERIFYING', 'IN_REVIEW', 'NEEDS_INFO', 'APPROVED']

export function MetricsStrip() {
  const { data, isPending, isError } = useMetrics()
  if (isPending) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={C.loading} role="status">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[104px]" />
        ))}
      </div>
    )
  }
  if (isError || !data) return null

  const current = Object.fromEntries(data.states.map((s) => [s.state, s.current])) as Partial<Record<ApplicationStatus, number>>
  const avg = Object.fromEntries(data.states.map((s) => [s.state, s.avg_ms])) as Partial<Record<ApplicationStatus, number | null>>
  const created = current.MERCHANT_CREATED ?? 0
  const attention = (current.NEEDS_INFO ?? 0) + (current.IN_REVIEW ?? 0) + (current.MERCHANT_CREATION_FAILED ?? 0)
  const verifying = avg.VERIFYING

  return (
    <section aria-label={C.region} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={C.applications}
          value={count(data.total_applications)}
          icon={Activity}
          tone="accent"
          hint={C.onboarded(count(created))}
          progress={data.total_applications ? created / data.total_applications : undefined}
        />
        <StatCard label={C.exceptionRate} value={`${Math.round(data.exception_rate * 100)}%`} icon={AlertTriangle} tone="warning" hint={C.exceptions(data.exception_count)} />
        <StatCard label={C.attention} value={count(attention)} icon={AlertTriangle} tone={attention > 0 ? 'danger' : 'neutral'} hint={C.attentionHint} />
        <StatCard label={C.avgVerifying} value={verifying == null ? '—' : duration(verifying)} icon={Timer} tone="info" hint={C.avgVerifyingHint} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-card border border-neutral-200 bg-white p-4 shadow-card lg:col-span-2">
          <h2 className="text-xs font-medium text-neutral-500">{C.byStatus}</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {APPLICATION_STATUSES.map((s) => {
              const n = current[s] ?? 0
              const Icon = STATUS_ICON[s]
              return (
                <li key={s}>
                  <Tooltip content={STATUS_LABELS[s].description}>
                    <span tabIndex={0} className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset', n ? TONE_SOFT[toneOf(STATUS_LABELS[s].severity)] : 'bg-white text-neutral-500 ring-neutral-200')}>
                      <Icon aria-hidden className="size-3.5" />
                      {STATUS_LABELS[s].label}
                      <span className="tabular font-semibold">{n}</span>
                    </span>
                  </Tooltip>
                </li>
              )
            })}
          </ul>
        </div>
        <div className="rounded-card border border-neutral-200 bg-white p-4 shadow-card">
          <h2 className="flex items-center gap-1.5 text-xs font-medium text-neutral-500">
            <CheckCircle2 aria-hidden className="size-3.5" /> {C.timeInState}
          </h2>
          <dl className="mt-3 space-y-1.5 text-sm">
            {TIMED.map((s) => (
              <div key={s} className="flex justify-between gap-3">
                <dt className="text-neutral-600">{STATUS_LABELS[s].label}</dt>
                <dd className="tabular font-medium text-neutral-900">{avg[s] == null ? '—' : duration(avg[s]!)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  )
}
