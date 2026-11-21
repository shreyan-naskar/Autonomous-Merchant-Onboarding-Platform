import { REVIEW_NOTE_MIN, type DeadJobDto, type DeadJobListDto } from '@app/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { Card, ErrorBox, Loading, buttonClass, inputClass, PageHeader } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { dateTime } from '../lib/format.ts'

/**
 * Dead-letter view: jobs that exhausted their retries (or had no handler).
 * Payloads arrive masked from the API. Requeue (with a required note, like
 * every operator action) resets attempts and makes the job due now; the
 * worker picks it up on its next tick.
 */
export function DeadLetters() {
  const { data, error, isPending } = useQuery({
    queryKey: ['jobs', 'dead'],
    queryFn: () => api.get<DeadJobListDto>('/jobs?status=dead'),
  })
  return (
    <>
    <PageHeader title="Dead letters" subtitle="Background jobs that failed every retry." />
    <Card title={`Dead-letter jobs${data ? ` (${data.count})` : ''}`}>
      <ErrorBox error={error} />
      {isPending && <Loading />}
      {data?.count === 0 && <p className="text-sm text-slate-500">No dead jobs.</p>}
      {data && data.count > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-2">Job</th>
              <th>Application</th>
              <th>Payload</th>
              <th>Attempts</th>
              <th>Last error</th>
              <th>Died</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((j) => (
              <DeadJobRow key={j.id} job={j} />
            ))}
          </tbody>
        </table>
      )}
    </Card>
    </>
  )
}

function DeadJobRow({ job }: { job: DeadJobDto }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const requeue = useMutation({
    mutationFn: () => api.post(`/jobs/${job.id}/requeue`, { note }),
    onSuccess: () => qc.invalidateQueries(),
  })
  const noteOk = note.trim().length >= REVIEW_NOTE_MIN
  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="py-2">
        <span className="font-mono text-xs text-slate-400">#{job.id}</span> <span className="font-medium">{job.type}</span>
      </td>
      <td>
        {job.application_id ? (
          <Link to={`/applications/${job.application_id}`} className="font-mono text-xs hover:underline">
            {job.application_id.slice(0, 8)}
          </Link>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td>
        <code className="block max-w-xs break-all text-xs text-slate-600">{JSON.stringify(job.payload)}</code>
      </td>
      <td className="tabular-nums">
        {job.attempts}/{job.max_attempts}
      </td>
      <td className="max-w-xs break-words text-xs text-red-700">{job.last_error ?? '—'}</td>
      <td className="text-xs text-slate-500">{dateTime(job.updated_at)}</td>
      <td className="min-w-48 space-y-1 text-right">
        <input
          className={inputClass}
          placeholder={`Note (min ${REVIEW_NOTE_MIN} chars)`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="button" className={buttonClass.primary} disabled={!noteOk || requeue.isPending} onClick={() => requeue.mutate()}>
          Requeue
        </button>
        <ErrorBox error={requeue.error} />
      </td>
    </tr>
  )
}
