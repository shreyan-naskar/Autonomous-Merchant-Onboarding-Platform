import type { ReviewQueueDto } from '@app/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { ReviewActions } from '../components/ReviewActions.tsx'
import { StatusBadge } from '../components/StatusBadge.tsx'
import { Card, ErrorBox, Loading } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { dateTime } from '../lib/format.ts'

/** Open review tasks across all applications, oldest first, each with the operator actions. */
export function ReviewQueue() {
  const { data, error, isPending } = useQuery({
    queryKey: ['review-tasks'],
    queryFn: () => api.get<ReviewQueueDto>('/review-tasks?status=OPEN'),
  })
  return (
    <Card title={`Review queue${data ? ` (${data.count} open)` : ''}`}>
      <ErrorBox error={error} />
      {isPending && <Loading />}
      {data?.count === 0 && <p className="text-sm text-slate-500">Nothing to review.</p>}
      <ul className="divide-y divide-slate-100">
        {data?.items.map((t) => (
          <li key={t.id} className="py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-slate-400">#{t.id}</span>
              <span className="rounded bg-orange-100 px-2 py-0.5 font-mono text-xs font-semibold text-orange-800">{t.reason}</span>
              <Link to={`/applications/${t.application_id}`} className="font-medium hover:underline">
                {t.merchant_name}
              </Link>
              <StatusBadge status={t.application_status} />
              <span className="text-xs text-slate-400">opened {dateTime(t.created_at)}</span>
            </div>
            {t.note && <p className="mt-1 text-sm text-slate-600">{t.note}</p>}
            <ReviewActions applicationId={t.application_id} taskId={t.id} status={t.application_status} />
          </li>
        ))}
      </ul>
    </Card>
  )
}
