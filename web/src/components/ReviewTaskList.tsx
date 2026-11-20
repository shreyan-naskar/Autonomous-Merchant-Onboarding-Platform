import type { ApplicationDetailDto, ApplicationStatus } from '@app/shared'
import { dateTime } from '../lib/format.ts'
import { ReviewActions } from './ReviewActions.tsx'

/** Review tasks of one application; open ones get the operator actions. */
export function ReviewTaskList({
  tasks,
  applicationId,
  status,
}: {
  tasks: ApplicationDetailDto['review_tasks']
  applicationId: string
  status: ApplicationStatus
}) {
  return (
    <ul className="divide-y divide-slate-100">
      {[...tasks].reverse().map((t) => (
        <li key={t.id} className="py-2">
          <div className="flex flex-wrap items-baseline gap-2 text-sm">
            <span className="font-mono text-xs text-slate-400">#{t.id}</span>
            <span className="font-semibold">{t.reason}</span>
            <span className={`rounded px-1.5 text-xs ${t.status === 'OPEN' ? 'bg-orange-100 text-orange-800' : 'bg-slate-100 text-slate-600'}`}>
              {t.status}
              {t.resolution ? ` · ${t.resolution}` : ''}
            </span>
            <span className="text-xs text-slate-400">{dateTime(t.created_at)}</span>
          </div>
          {t.note && <p className="mt-1 text-sm text-slate-600">{t.note}</p>}
          {t.resolution_note && <p className="mt-1 text-sm italic text-slate-600">Operator note: “{t.resolution_note}”</p>}
          {t.status === 'OPEN' && <ReviewActions applicationId={applicationId} taskId={t.id} status={status} />}
        </li>
      ))}
    </ul>
  )
}
