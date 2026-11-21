import { describeReason } from '@app/shared'
import { CheckCircle2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { TaskCard } from '../components/review.tsx'
import { PageError } from '../components/errors.tsx'
import { EmptyState, PageHeader, Skeleton, cx } from '../components/ui.tsx'
import { useOpenTasks } from '../lib/queries.ts'

type Filter = 'all' | 'danger' | 'warning' | 'info'

/** Open exceptions across all applications, oldest first, as cards with actions. */
export function ReviewQueue() {
  const { data, error, isPending, refetch } = useOpenTasks()
  const [filter, setFilter] = useState<Filter>('all')
  const items = data?.items ?? []
  const shown = useMemo(() => (filter === 'all' ? items : items.filter((t) => describeReason(t.reason).severity === filter)), [items, filter])
  const count = (f: Filter) => (f === 'all' ? items.length : items.filter((t) => describeReason(t.reason).severity === f).length)

  return (
    <>
      <PageHeader title="Review queue" subtitle="Exceptions waiting for a person to decide, oldest first. Every decision needs a note for the audit trail." />
      {error && !data ? (
        <PageError error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <div className="grid gap-3 lg:grid-cols-2" role="status" aria-label="Loading review tasks">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-card border border-neutral-200 bg-white shadow-card">
          <EmptyState icon={CheckCircle2} title="Nothing to review" text="New exceptions (failed checks, unclear or conflicting documents, high risk) appear here." />
        </div>
      ) : (
        <div className="space-y-4">
          <div role="group" aria-label="Filter by severity" className="flex flex-wrap gap-1.5">
            {(
              [
                ['all', 'All'],
                ['danger', 'Failures'],
                ['warning', 'Needs judgement'],
                ['info', 'Informational'],
              ] as const
            ).map(([f, label]) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cx(
                  'rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset',
                  filter === f ? 'bg-accent-700 text-white ring-accent-700' : 'bg-white text-neutral-700 ring-neutral-300 hover:bg-neutral-50',
                )}
              >
                {label} <span className="tabular opacity-80">{count(f)}</span>
              </button>
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {shown.map((t) => (
              <TaskCard key={t.id} task={t} applicationId={t.application_id} merchantName={t.merchant_name} status={t.application_status} />
            ))}
          </div>
        </div>
      )}
    </>
  )
}
