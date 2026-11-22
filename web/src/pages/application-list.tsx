import { APPLICATION_STATUSES, STATUS_LABELS, type ApplicationStatus, type ApplicationSummaryDto } from '@app/shared'
import { ArrowDown, ArrowUp, ChevronsUpDown, Inbox, Search, SearchX } from 'lucide-react'
import { useMemo, type KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { APPLICATIONS as C } from '../copy.ts'
import { MetricsStrip } from '../components/metrics-strip.tsx'
import { PageError } from '../components/errors.tsx'
import { Button, Card, EmptyState, PageHeader, SkeletonRows, Switch } from '../components/ui.tsx'
import { cx } from '../lib/tone.ts'
import { dateTime, duration, relativeTime } from '../lib/format.ts'
import { NEEDS_ATTENTION } from '../lib/status.ts'
import { StatusBadge } from '../components/status-badge.tsx'
import { useApplications } from '../lib/queries.ts'

type SortKey = 'submitted' | 'time_in_state'

/** Filters live in the URL so they survive reloads and can be shared. */
export function ApplicationList() {
  const [params, setParams] = useSearchParams()
  const status = params.get('status') as ApplicationStatus | null
  const attention = params.get('attention') === '1'
  const q = params.get('q') ?? ''
  const sort = (params.get('sort') as SortKey | null) ?? 'submitted'
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const navigate = useNavigate()
  const { data, error, isPending, refetch } = useApplications()

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }

  const all = useMemo(() => data?.items ?? [], [data])
  const counts = useMemo(() => {
    const c: Partial<Record<ApplicationStatus, number>> = {}
    for (const a of all) c[a.status] = (c[a.status] ?? 0) + 1
    return c
  }, [all])

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    const filtered = all.filter(
      (a) =>
        (!status || a.status === status) &&
        (!attention || NEEDS_ATTENTION.includes(a.status) || a.open_review_count > 0) &&
        (!term || a.merchant_name.toLowerCase().includes(term) || a.id.toLowerCase().startsWith(term)),
    )
    const key = (a: ApplicationSummaryDto) => (sort === 'time_in_state' ? a.time_in_state_ms : new Date(a.created_at).getTime())
    return [...filtered].sort((a, b) => (dir === 'asc' ? key(a) - key(b) : key(b) - key(a)))
  }, [all, status, attention, q, sort, dir])

  const toggleSort = (k: SortKey) => set({ sort: k, dir: sort === k && dir === 'desc' ? 'asc' : 'desc' })
  const filtersOn = Boolean(status || attention || q)

  return (
    <div className="space-y-5">
      <PageHeader
        title={C.title}
        subtitle={C.subtitle}
      />
      <MetricsStrip />

      <Card padded={false}>
        <div className="space-y-3 border-b border-neutral-100 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-72">
              <label htmlFor="list-search" className="sr-only">
                {C.filterLabel}
              </label>
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-neutral-500" />
              <input
                id="list-search"
                type="search"
                value={q}
                onChange={(e) => set({ q: e.target.value })}
                placeholder={C.filterPlaceholder}
                className="h-9 w-full rounded-control border border-neutral-300 pr-3 pl-8 text-sm placeholder:text-neutral-400 focus:border-success-700 focus:ring-2 focus:ring-highlight-400/60 focus:outline-none"
              />
            </div>
            <div className="sm:ml-auto">
              <Switch label={C.attentionOnly} checked={attention} onChange={(on) => set({ attention: on ? '1' : null })} />
            </div>
          </div>
          <div role="group" aria-label={C.statusFilter} className="flex flex-wrap gap-1.5">
            <Chip active={!status} onClick={() => set({ status: null })} label={C.all} count={all.length} />
            {APPLICATION_STATUSES.filter((s) => counts[s] || s === status).map((s) => (
              <Chip key={s} active={status === s} onClick={() => set({ status: status === s ? null : s })} label={STATUS_LABELS[s].label} count={counts[s] ?? 0} />
            ))}
          </div>
        </div>

        {error && !data ? (
          <div className="p-4">
            <PageError error={error} onRetry={() => void refetch()} />
          </div>
        ) : isPending ? (
          <div className="p-4">
            <SkeletonRows rows={6} label={C.loading} />
          </div>
        ) : all.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={C.empty}
            text={C.emptyText}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title={C.noMatch}
            text={C.noMatchText}
            action={filtersOn && <Button onClick={() => setParams({}, { replace: true })}>{C.clearFilters}</Button>}
          />
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <caption className="sr-only">{C.caption(rows.length)}</caption>
              <thead className="bg-neutral-50 text-2xs font-bold tracking-wide text-neutral-500 uppercase">
                <tr>
                  <th scope="col" className="px-4 py-2 font-bold">{C.columns.merchant}</th>
                  <th scope="col" className="px-4 py-2 font-bold">{C.columns.status}</th>
                  <SortHeader label={C.columns.timeInState} align="right" active={sort === 'time_in_state'} dir={dir} onClick={() => toggleSort('time_in_state')} />
                  <th scope="col" className="px-4 py-2 text-right font-bold">{C.columns.openReviews}</th>
                  <th scope="col" className="px-4 py-2 font-bold">{C.columns.mid}</th>
                  <SortHeader label={C.columns.submitted} active={sort === 'submitted'} dir={dir} onClick={() => toggleSort('submitted')} />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <Row key={a.id} a={a} onOpen={() => navigate(`/applications/${a.id}`)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function Row({ a, onOpen }: { a: ApplicationSummaryDto; onOpen: () => void }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') onOpen()
  }
  return (
    <tr onClick={onOpen} onKeyDown={onKey} className="cursor-pointer border-t border-neutral-100 transition-colors hover:bg-neutral-100">
      <td className="px-4 py-2.5">
        {/* The link is the keyboard / screen-reader target; the whole row is the mouse target. */}
        <Link to={`/applications/${a.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-neutral-900 hover:text-accent-800">
          {a.merchant_name}
        </Link>
        <div className="font-mono text-2xs text-neutral-500">{a.id.slice(0, 8)}</div>
      </td>
      <td className="px-4 py-2.5">
        <StatusBadge status={a.status} />
      </td>
      <td className="tabular px-4 py-3 text-right text-neutral-700">{duration(a.time_in_state_ms)}</td>
      <td className="px-4 py-2.5 text-right">
        {a.open_review_count > 0 ? (
          <span className="tabular inline-flex min-w-6 justify-center rounded-full bg-warning-100 px-2 py-0.5 text-xs font-semibold text-warning-800 ring-1 ring-warning-200 ring-inset">
            {a.open_review_count}
            <span className="sr-only"> {C.openTasks}</span>
          </span>
        ) : (
          <span className="text-neutral-500">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 font-mono text-xs text-neutral-700">{a.merchant_id ?? <span className="text-neutral-500">—</span>}</td>
      <td className="px-4 py-2.5 text-neutral-500" title={dateTime(a.created_at)}>
        {relativeTime(a.created_at)}
      </td>
    </tr>
  )
}

function SortHeader({ label, active, dir, onClick, align }: { label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void; align?: 'right' }) {
  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th scope="col" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={cx('px-4 py-2 font-bold', align === 'right' && 'text-right')}>
      <button type="button" onClick={onClick} className={cx('inline-flex items-center gap-1 font-bold tracking-wide uppercase hover:text-accent-700', active && 'text-accent-700')}>
        {label}
        <Icon aria-hidden className="size-3.5" />
      </button>
    </th>
  )
}

function Chip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors ring-inset',
        active ? 'bg-accent-700 text-white ring-accent-700' : 'bg-white text-neutral-700 ring-neutral-300 hover:bg-neutral-50',
      )}
    >
      {label}
      <span className={cx('tabular rounded-full px-1.5 text-2xs', active ? 'bg-white/20' : 'bg-neutral-100 text-neutral-600')}>{count}</span>
    </button>
  )
}
