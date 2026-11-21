import {
  describeReason,
  RESOLUTION_LABELS,
  REVIEW_NOTE_MIN,
  resolutionsFor,
  type ApplicationDetailDto,
  type ApplicationStatus,
  type ReviewResolution,
} from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, ExternalLink, FileQuestion, RefreshCcw, RotateCcw, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { api, fieldErrors, isApiError } from '../lib/api.ts'
import { relativeTime } from '../lib/format.ts'
import { ReasonBadge, StatusBadge } from './status-badge.tsx'
import { useToast } from '../lib/toast.ts'
import { Button, Dialog, ErrorAlert, Textarea, type ButtonProps } from './ui.tsx'

interface TaskLike {
  id: number
  reason: string
  status: 'OPEN' | 'RESOLVED'
  note: string | null
  resolution: string | null
  resolution_note: string | null
  related_application_id: string | null
  created_at: string
}

const EFFECT: Record<ReviewResolution, string> = {
  APPROVE: 'The application is approved and a merchant ID is created. Approval still requires every check to have passed.',
  REJECT: 'The application is rejected. This is final.',
  REQUEST_INFO: 'The application goes back to the merchant, who is asked for more information.',
  RETRY_VERIFICATION: 'The checks that did not pass are sent to the providers again.',
  RETRY_MERCHANT_CREATION: 'Merchant ID creation is attempted again.',
  DISMISS: 'The task is closed without changing the application.',
}

const ACTION: Record<ReviewResolution, { variant: ButtonProps['variant']; icon: ButtonProps['icon'] }> = {
  APPROVE: { variant: 'primary', icon: ThumbsUp },
  REJECT: { variant: 'danger', icon: ThumbsDown },
  REQUEST_INFO: { variant: 'secondary', icon: FileQuestion },
  RETRY_VERIFICATION: { variant: 'secondary', icon: RefreshCcw },
  RETRY_MERCHANT_CREATION: { variant: 'primary', icon: RotateCcw },
  DISMISS: { variant: 'ghost', icon: X },
}

const DONE: Record<ReviewResolution, string> = {
  APPROVE: 'Application approved',
  REJECT: 'Application rejected',
  REQUEST_INFO: 'Information requested from the merchant',
  RETRY_VERIFICATION: 'Verification restarted',
  RETRY_MERCHANT_CREATION: 'Merchant ID creation retried',
  DISMISS: 'Task dismissed',
}

/** A 409 (guard or wrong state) is shown inline and the dialog stays open, so the reviewer keeps their note. */
function ReviewDialog({
  open,
  onClose,
  applicationId,
  merchantName,
  task,
  resolution,
}: {
  open: boolean
  onClose: () => void
  applicationId: string
  merchantName: string
  task: TaskLike
  resolution: ReviewResolution
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const [note, setNote] = useState('')
  const resolve = useMutation({
    mutationFn: () => api.post<ApplicationDetailDto>(`/applications/${applicationId}/review`, { taskId: task.id, resolution, note }),
    onSuccess: async () => {
      toast.push({ tone: 'success', title: DONE[resolution], message: merchantName })
      setNote('')
      onClose()
      await qc.invalidateQueries()
    },
  })
  const trimmed = note.trim().length
  const valid = trimmed >= REVIEW_NOTE_MIN
  const noteError = fieldErrors(resolve.error).note
  const reason = describeReason(task.reason)
  const a = ACTION[resolution]
  const close = () => {
    resolve.reset()
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`${RESOLUTION_LABELS[resolution]}: ${merchantName}`}
      description={EFFECT[resolution]}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant={a.variant === 'ghost' ? 'secondary' : a.variant} icon={a.icon} disabled={!valid} loading={resolve.isPending} onClick={() => resolve.mutate()}>
            {RESOLUTION_LABELS[resolution]}
          </Button>
        </>
      }
    >
      <div className="rounded-control bg-neutral-50 px-3 py-2 text-sm">
        <div className="text-xs text-neutral-500">Reason for review</div>
        <div className="mt-0.5 font-medium text-neutral-900">{reason.label}</div>
        {task.note && <p className="mt-1 text-xs text-neutral-600">{task.note}</p>}
      </div>
      <Textarea
        data-autofocus
        label="Note for the audit trail"
        required
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        error={noteError}
        hint={
          <span className="tabular" aria-live="polite">
            {trimmed < REVIEW_NOTE_MIN ? `${trimmed} / ${REVIEW_NOTE_MIN} characters minimum` : `${trimmed} characters`}
          </span>
        }
        placeholder="Why are you making this decision?"
      />
      {resolve.error && !(isApiError(resolve.error) && resolve.error.kind === 'validation') && <ErrorAlert error={resolve.error} />}
    </Dialog>
  )
}

export function TaskActions({
  task,
  applicationId,
  merchantName,
  status,
  size = 'sm',
}: {
  task: TaskLike
  applicationId: string
  merchantName: string
  status: ApplicationStatus
  size?: 'sm' | 'md'
}) {
  const [pending, setPending] = useState<ReviewResolution | null>(null)
  const offered = resolutionsFor(status, task.reason)
  if (offered.length === 0) {
    return <p className="text-xs text-neutral-500">No action possible while the application is in this state.</p>
  }
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {offered.map((r) => (
          <Button key={r} size={size} variant={ACTION[r].variant} icon={ACTION[r].icon} onClick={() => setPending(r)}>
            {RESOLUTION_LABELS[r]}
          </Button>
        ))}
      </div>
      {pending && (
        <ReviewDialog open onClose={() => setPending(null)} applicationId={applicationId} merchantName={merchantName} task={task} resolution={pending} />
      )}
    </>
  )
}

export function TaskCard({
  task,
  applicationId,
  merchantName,
  status,
  showApplication = true,
}: {
  task: TaskLike
  applicationId: string
  merchantName: string
  status: ApplicationStatus
  showApplication?: boolean
}) {
  const reason = describeReason(task.reason)
  const open = task.status === 'OPEN'
  return (
    <article className="rounded-card border border-neutral-200 bg-white p-4 shadow-card" aria-label={`${reason.label} for ${merchantName}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1.5">
          <ReasonBadge reason={task.reason} />
          {showApplication && (
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/applications/${applicationId}`} className="inline-flex items-center gap-1 text-sm font-semibold text-neutral-900 hover:text-accent-800 hover:underline">
                {merchantName}
                <ArrowRight aria-hidden className="size-3.5" />
              </Link>
              <StatusBadge status={status} />
            </div>
          )}
        </div>
        <time dateTime={task.created_at} title={new Date(task.created_at).toLocaleString()} className="text-xs text-neutral-500">
          opened {relativeTime(task.created_at)}
        </time>
      </div>
      {reason.description && <p className="mt-2 text-sm text-neutral-600">{reason.description}</p>}
      {task.note && <p className="mt-2 rounded-control bg-neutral-50 px-3 py-2 text-xs text-neutral-700">{task.note}</p>}
      {task.related_application_id && (
        <p className="mt-2 text-sm">
          Possible duplicate of{' '}
          <Link className="inline-flex items-center gap-1 font-mono text-xs text-accent-800 hover:underline" to={`/applications/${task.related_application_id}`}>
            {task.related_application_id.slice(0, 8)}
            <ExternalLink aria-hidden className="size-3" />
          </Link>
        </p>
      )}
      {task.reason === 'JOB_DEAD' && open && (
        <p className="mt-2 text-sm">
          <Link to="/dead-letters" className="text-accent-800 hover:underline">
            Requeue the job from Dead letters
          </Link>
        </p>
      )}
      <div className="mt-3">
        {open ? (
          <TaskActions task={task} applicationId={applicationId} merchantName={merchantName} status={status} />
        ) : (
          <p className="flex items-start gap-1.5 text-xs text-neutral-600">
            <Check aria-hidden className="mt-0.5 size-3.5 text-success-700" />
            <span>
              Resolved: <b>{task.resolution ? (RESOLUTION_LABELS[task.resolution as ReviewResolution] ?? task.resolution) : '—'}</b>
              {task.resolution_note && <> · “{task.resolution_note}”</>}
            </span>
          </p>
        )}
      </div>
    </article>
  )
}
