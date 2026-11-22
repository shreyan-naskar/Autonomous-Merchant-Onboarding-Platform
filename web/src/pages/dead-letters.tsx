import { REVIEW_NOTE_MIN, type DeadJobDto } from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArchiveX, ArrowRight, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { PageError } from '../components/errors.tsx'
import { useToast } from '../lib/toast.ts'
import { Badge, Button, Card, Dialog, EmptyState, ErrorAlert, PageHeader, SkeletonRows, Textarea } from '../components/ui.tsx'
import { api, fieldErrors } from '../lib/api.ts'
import { relativeTime } from '../lib/format.ts'
import { useDeadJobs } from '../lib/queries.ts'
import { COMMON, DEAD_LETTERS as C } from '../copy.ts'

const JOB_NAMES = C.jobs

export function DeadLetters() {
  const { data, error, isPending, refetch } = useDeadJobs()
  const [requeue, setRequeue] = useState<DeadJobDto | null>(null)
  return (
    <>
      <PageHeader title={C.title} subtitle={C.subtitle} />
      <Card padded={false}>
        {error && !data ? (
          <div className="p-4">
            <PageError error={error} onRetry={() => void refetch()} />
          </div>
        ) : isPending ? (
          <div className="p-4">
            <SkeletonRows rows={3} label={C.loading} />
          </div>
        ) : !data || data.count === 0 ? (
          <EmptyState icon={ArchiveX} title={C.empty} />
        ) : (
          <ul className="divide-y divide-neutral-100">
            {data.items.map((j) => (
              <li key={j.id} className="flex flex-wrap items-start gap-4 p-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-neutral-900">{JOB_NAMES[j.type] ?? j.type}</span>
                    <Badge tone="danger">
                      {C.attempts(j.attempts, j.max_attempts)}
                    </Badge>
                    <span className="font-mono text-2xs text-neutral-500">
                      #{j.id} · {j.type}
                    </span>
                  </div>
                  {j.application_id && (
                    <Link to={`/applications/${j.application_id}`} className="inline-flex items-center gap-1 text-sm text-accent-800 hover:underline">
                      {C.application(j.application_id.slice(0, 8))} <ArrowRight aria-hidden className="size-3.5" />
                    </Link>
                  )}
                  {j.last_error && <p className="rounded-control bg-danger-50 px-2.5 py-1.5 font-mono text-xs break-words text-danger-800">{j.last_error}</p>}
                  <p className="text-xs text-neutral-500">{C.gaveUp(relativeTime(j.updated_at))}</p>
                </div>
                <Button variant="primary" icon={RotateCcw} onClick={() => setRequeue(j)}>
                  {C.requeue}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {requeue && <RequeueDialog job={requeue} onClose={() => setRequeue(null)} />}
    </>
  )
}

function RequeueDialog({ job, onClose }: { job: DeadJobDto; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [note, setNote] = useState('')
  const m = useMutation({
    mutationFn: () => api.post(`/jobs/${job.id}/requeue`, { note }),
    onSuccess: async () => {
      toast.push({ tone: 'success', title: C.requeued, message: C.requeuedText(JOB_NAMES[job.type] ?? job.type) })
      onClose()
      await qc.invalidateQueries()
    },
  })
  const n = note.trim().length
  return (
    <Dialog
      open
      onClose={onClose}
      title={C.requeueTitle(JOB_NAMES[job.type] ?? job.type)}
      description={C.requeueText}
      footer={
        <>
          <Button onClick={onClose}>{COMMON.cancel}</Button>
          <Button variant="primary" icon={RotateCcw} disabled={n < REVIEW_NOTE_MIN} loading={m.isPending} onClick={() => m.mutate()}>
            {C.requeue}
          </Button>
        </>
      }
    >
      <Textarea
        data-autofocus
        label={COMMON.noteLabel}
        required
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        error={fieldErrors(m.error).note}
        hint={
          <span className="tabular" aria-live="polite">
            {COMMON.noteCount(n, REVIEW_NOTE_MIN)}
          </span>
        }
        placeholder={C.notePlaceholder}
      />
      {m.error && !fieldErrors(m.error).note && <ErrorAlert error={m.error} />}
    </Dialog>
  )
}
