import { REVIEW_NOTE_MIN, type DeadJobDto } from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArchiveX, ArrowRight, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { useToast } from '../components/toast.tsx'
import { Badge, Button, Card, Dialog, EmptyState, ErrorAlert, PageHeader, SkeletonRows, Textarea } from '../components/ui.tsx'
import { api, fieldErrors } from '../lib/api.ts'
import { relativeTime } from '../lib/format.ts'
import { useDeadJobs } from '../lib/queries.ts'

const JOB_NAMES: Record<string, string> = {
  extract: 'Read documents',
  start_verifications: 'Send checks to providers',
  verification_timeout: 'Check for provider timeout',
  approve: 'Approve',
  create_merchant: 'Create merchant ID',
}

/**
 * Jobs that failed every retry (or had no handler). Payloads arrive masked
 * from the API. Requeue (with a required note) resets the attempts and makes
 * the job due now.
 */
export function DeadLetters() {
  const { data, error, isPending } = useDeadJobs()
  const [requeue, setRequeue] = useState<DeadJobDto | null>(null)
  return (
    <>
      <PageHeader title="Dead letters" subtitle="Background steps that failed every retry. Fix the cause (for example end a provider outage), then requeue." />
      <Card padded={false}>
        {error && !data ? (
          <div className="p-4">
            <ErrorAlert error={error} />
          </div>
        ) : isPending ? (
          <div className="p-4">
            <SkeletonRows rows={3} label="Loading dead letters" />
          </div>
        ) : !data || data.count === 0 ? (
          <EmptyState icon={ArchiveX} title="No dead letters" text="When a background step fails every retry (try Demo controls, Provider outage) it shows up here." />
        ) : (
          <ul className="divide-y divide-neutral-100">
            {data.items.map((j) => (
              <li key={j.id} className="flex flex-wrap items-start gap-4 p-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-neutral-900">{JOB_NAMES[j.type] ?? j.type}</span>
                    <Badge tone="danger">
                      {j.attempts}/{j.max_attempts} attempts
                    </Badge>
                    <span className="font-mono text-2xs text-neutral-400">
                      #{j.id} · {j.type}
                    </span>
                  </div>
                  {j.application_id && (
                    <Link to={`/applications/${j.application_id}`} className="inline-flex items-center gap-1 text-sm text-accent-800 hover:underline">
                      Application {j.application_id.slice(0, 8)} <ArrowRight aria-hidden className="size-3.5" />
                    </Link>
                  )}
                  {j.last_error && <p className="rounded-control bg-danger-50 px-2.5 py-1.5 font-mono text-xs break-words text-danger-800">{j.last_error}</p>}
                  <p className="text-xs text-neutral-500">gave up {relativeTime(j.updated_at)}</p>
                </div>
                <Button variant="primary" icon={RotateCcw} onClick={() => setRequeue(j)}>
                  Requeue
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
      toast.push({ tone: 'success', title: 'Job requeued', message: `${JOB_NAMES[job.type] ?? job.type} will run again now.` })
      onClose()
      await qc.invalidateQueries()
    },
  })
  const n = note.trim().length
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Requeue: ${JOB_NAMES[job.type] ?? job.type}`}
      description="The job runs again now with a fresh set of retries. Make sure the cause is fixed first."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={RotateCcw} disabled={n < REVIEW_NOTE_MIN} loading={m.isPending} onClick={() => m.mutate()}>
            Requeue
          </Button>
        </>
      }
    >
      <Textarea
        data-autofocus
        label="Note for the audit trail"
        required
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        error={fieldErrors(m.error).note}
        hint={<span className="tabular" aria-live="polite">{n < REVIEW_NOTE_MIN ? `${n} / ${REVIEW_NOTE_MIN} characters minimum` : `${n} characters`}</span>}
        placeholder="e.g. Provider outage is over"
      />
      {m.error && !fieldErrors(m.error).note && <ErrorAlert error={m.error} />}
    </Dialog>
  )
}
