import { APPLICATION_STATUSES, STATUS_LABELS, type ApplicationStatus, type ApplicationSummaryDto } from '@app/shared'
import { ArrowDown, ArrowUp, ChevronsUpDown, FilePlus2, Inbox, Search, SearchX } from 'lucide-react'
import { useMemo, type KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { MetricsStrip } from '../components/MetricsStrip.tsx'
import { Button, Card, EmptyState, ErrorAlert, PageHeader, SkeletonRows, Switch, cx } from '../components/ui.tsx'
import { duration, relativeTime } from '../lib/format.ts'
import { NEEDS_ATTENTION, StatusBadge } from '../lib/labels.tsx'
import { useApplications } from '../lib/queries.ts'

type SortKey = 'submitted' | 'time_in_state'

/**
 * Every application, filterable by status chips, "needs attention" and a
 * search; sortable by time in state or submission time. Filters live in the
 * URL so they survive reloads and can be shared.
 */
export function ApplicationList() {
  const [params, setParams] = useSearchParams()
  const status = params.get('status') as ApplicationStatus | null
  const attention = params.get('attention') === '1'
  const q = params.get('q') ?? ''
  const sort = (params.get('sort') as SortKey | null) ?? 'submitted'
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const navigate = useNavigate()
  const { data, error, isPending } = useApplications()

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }

  const all = data?.items ?? []
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
        title="Applications"
        subtitle="Every merchant application and where it is in onboarding."
        actions={
          <Link to="/submit" className="inline-flex h-9 items-center gap-1.5 rounded-control bg-accent-700 px-3.5 text-sm font-medium text-white shadow-sm hover:bg-accent-800">
            <FilePlus2 aria-hidden className="size-4" /> Submit an application
          </Link>
        }
      />
      <MetricsStrip />

      <Card padded={false}>
        <div className="space-y-3 border-b border-neutral-100 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-72">
              <label htmlFor="list-search" className="sr-only">
                Filter by merchant name or ID
              </label>
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-neutral-400" />
              <input
                id="list-search"
                type="search"
                value={q}
                onChange={(e) => set({ q: e.target.value })}
                placeholder="Filter by merchant or ID"
                className="h-9 w-full rounded-control border border-neutral-300 pr-3 pl-8 text-sm placeholder:text-neutral-400 focus:border-accent-600 focus:ring-2 focus:ring-accent-600/20 focus:outline-none"
              />
            </div>
            <div className="sm:ml-auto">
              <Switch label="Needs attention only" checked={attention} onChange={(on) => set({ attention: on ? '1' : null })} />
            </div>
          </div>
          <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
            <Chip active={!status} onClick={() => set({ status: null })} label="All" count={all.length} />
            {APPLICATION_STATUSES.filter((s) => counts[s] || s === status).map((s) => (
              <Chip key={s} active={status === s} onClick={() => set({ status: status === s ? null : s })} label={STATUS_LABELS[s].label} count={counts[s] ?? 0} />
            ))}
          </div>
        </div>

        {error && !data ? (
          <div className="p-4">
            <ErrorAlert error={error} />
          </div>
        ) : isPending ? (
          <div className="p-4">
            <SkeletonRows rows={6} label="Loading applications" />
          </div>
        ) : all.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No applications yet"
            text="Submit a merchant application (or load a sample) to see it move through onboarding."
            action={
              <Button variant="primary" icon={FilePlus2} onClick={() => navigate('/submit')}>
                Submit an application
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="No applications match"
            text="Try another status or search."
            action={filtersOn && <Button onClick={() => setParams({}, { replace: true })}>Clear filters</Button>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <caption className="sr-only">Applications, {rows.length} shown</caption>
              <thead className="bg-neutral-50 text-xs text-neutral-500">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Merchant</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <SortHeader label="Time in state" active={sort === 'time_in_state'} dir={dir} onClick={() => toggleSort('time_in_state')} />
                  <th scope="col" className="px-4 py-2.5 font-medium">Open reviews</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Merchant ID</th>
                  <SortHeader label="Submitted" active={sort === 'submitted'} dir={dir} onClick={() => toggleSort('submitted')} />
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
    <tr onClick={onOpen} onKeyDown={onKey} className="cursor-pointer border-t border-neutral-100 transition-colors hover:bg-accent-50/50">
      <td className="px-4 py-3">
        {/* The link is the keyboard / screen-reader target; the whole row is the mouse target. */}
        <Link to={`/applications/${a.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-neutral-900 hover:text-accent-800">
          {a.merchant_name}
        </Link>
        <div className="font-mono text-2xs text-neutral-400">{a.id.slice(0, 8)}</div>
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={a.status} />
      </td>
      <td className="tabular px-4 py-3 text-neutral-700">{duration(a.time_in_state_ms)}</td>
      <td className="px-4 py-3">
        {a.open_review_count > 0 ? (
          <span className="tabular inline-flex min-w-6 justify-center rounded-full bg-warning-100 px-2 py-0.5 text-xs font-semibold text-warning-800 ring-1 ring-warning-200 ring-inset">
            {a.open_review_count}
            <span className="sr-only"> open review tasks</span>
          </span>
        ) : (
          <span className="text-neutral-400">—</span>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-neutral-700">{a.merchant_id ?? <span className="text-neutral-400">—</span>}</td>
      <td className="px-4 py-3 text-neutral-500" title={new Date(a.created_at).toLocaleString()}>
        {relativeTime(a.created_at)}
      </td>
    </tr>
  )
}

function SortHeader({ label, active, dir, onClick }: { label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void }) {
  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th scope="col" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} className="px-4 py-2.5 font-medium">
      <button type="button" onClick={onClick} className={cx('inline-flex items-center gap-1 hover:text-neutral-800', active && 'text-neutral-800')}>
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
