import {
  CHECK_LABELS,
  DOCUMENT_LABELS,
  describeReason,
  RESOLUTION_LABELS,
  REVIEW_NOTE_MIN,
  REVIEW_RESOLUTION_FROM,
  resolutionLabel,
  resolutionsFor,
  type ApplicationDetailDto,
  VERIFICATION_STATUS_LABELS,
  type ApplicationStatus,
  type CheckProgress,
  type CurrentCheckDto,
  type ReviewResolution,
} from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, ExternalLink, FileCheck, FileQuestion, Info, RefreshCcw, RotateCcw, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { api, fieldErrors, isApiError } from '../lib/api.ts'
import { ReasonBadge, StatusBadge } from './status-badge.tsx'
import { useToast } from '../lib/toast.ts'
import { ViewDocumentButton } from './document-viewer.tsx'
import { Badge, Button, Dialog, ErrorAlert, Textarea, type ButtonProps } from './ui.tsx'
import { toneOf } from '../lib/status.ts'
import { COMMON, REVIEW as C } from '../copy.ts'
import { dateTime, relativeTime } from '../lib/format.ts'

/** Tasks raised while reading documents: judging them means looking at the files. */
const DOCUMENT_TASK_REASONS: readonly string[] = ['LOW_CONFIDENCE', 'DOC_CONFLICT', 'BLURRY_DOCUMENT']

/** The uploaded files the task note names (e.g. "BANK_PROOF.ifsc"), else every uploaded file. */
function documentsToLookAt(app: ApplicationDetailDto, note: string | null) {
  const uploaded = app.documents.filter((d) => d.file_name !== null)
  const named = uploaded.filter((d) => note?.includes(d.type))
  return named.length > 0 ? named : uploaded
}

/** Live check statuses: the task note below is a snapshot from when the task opened. */
function ChecksNow({ checks }: { checks: CurrentCheckDto[] }) {
  return (
    <div className="mt-2">
      <p className="text-2xs font-medium text-neutral-500">{C.checksNow}</p>
      <ul aria-label={C.checksNowLabel} className="mt-1 flex flex-wrap gap-1.5">
        {checks.map(({ kind, status }) => {
          const st = status ? VERIFICATION_STATUS_LABELS[status] : null
          return (
            <li key={kind}>
              <Badge tone={st ? toneOf(st.severity) : 'neutral'} title={status ?? undefined}>
                {CHECK_LABELS[kind]}: {st ? st.label : C.notStarted}
              </Badge>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

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

function effectOf(r: ReviewResolution, checks: CheckProgress): string {
  if (r === 'RETRY_VERIFICATION') {
    return checks === 'NOT_STARTED' ? C.effect.RETRY_NOT_STARTED : checks === 'ALL_PASSED' ? C.effect.RETRY_ALL_PASSED : C.effect.RETRY_SOME
  }
  return C.effect[r]
}

function actionStyle(r: ReviewResolution, checks: CheckProgress): { variant: ButtonProps['variant']; icon: ButtonProps['icon'] } {
  switch (r) {
    case 'APPROVE':
      return { variant: 'primary', icon: ThumbsUp }
    case 'REJECT':
      return { variant: 'danger', icon: ThumbsDown }
    case 'REQUEST_INFO':
      return { variant: 'secondary', icon: FileQuestion }
    case 'RETRY_VERIFICATION':
      return checks === 'NOT_STARTED' ? { variant: 'primary', icon: FileCheck } : { variant: 'secondary', icon: RefreshCcw }
    case 'RETRY_MERCHANT_CREATION':
      return { variant: 'primary', icon: RotateCcw }
    case 'DISMISS':
      return { variant: 'ghost', icon: X }
  }
}

function doneOf(r: ReviewResolution, checks: CheckProgress): string {
  if (r === 'RETRY_VERIFICATION') return checks === 'NOT_STARTED' ? C.done.RETRY_NOT_STARTED : C.done.RETRY
  return C.done[r]
}

/** Why Approve is missing, when it would otherwise be a decision for this state. */
function approveHint(status: ApplicationStatus, checks: CheckProgress): string | null {
  if (checks === 'ALL_PASSED' || !REVIEW_RESOLUTION_FROM.APPROVE.includes(status)) return null
  return checks === 'NOT_STARTED' ? C.approveNotStarted : C.approveIncomplete
}

/** A 409 (guard or wrong state) is shown inline and the dialog stays open, so the reviewer keeps their note. */
function ReviewDialog({
  open,
  onClose,
  applicationId,
  merchantName,
  task,
  resolution,
  checks,
}: {
  open: boolean
  onClose: () => void
  applicationId: string
  merchantName: string
  task: TaskLike
  resolution: ReviewResolution
  checks: CheckProgress
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const [note, setNote] = useState('')
  const resolve = useMutation({
    mutationFn: () => api.post<ApplicationDetailDto>(`/applications/${applicationId}/review`, { taskId: task.id, resolution, note }),
    onSuccess: async () => {
      toast.push({ tone: 'success', title: doneOf(resolution, checks), message: merchantName })
      setNote('')
      onClose()
      await qc.invalidateQueries()
    },
  })
  const trimmed = note.trim().length
  const valid = trimmed >= REVIEW_NOTE_MIN
  const noteError = fieldErrors(resolve.error).note
  const reason = describeReason(task.reason)
  const a = actionStyle(resolution, checks)
  const label = resolutionLabel(resolution, checks)
  const close = () => {
    resolve.reset()
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`${label}: ${merchantName}`}
      description={effectOf(resolution, checks)}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            {COMMON.cancel}
          </Button>
          <Button variant={a.variant === 'ghost' ? 'secondary' : a.variant} icon={a.icon} disabled={!valid} loading={resolve.isPending} onClick={() => resolve.mutate()}>
            {label}
          </Button>
        </>
      }
    >
      <div className="rounded-control bg-neutral-50 px-3 py-2 text-sm">
        <div className="text-xs text-neutral-500">{C.reason}</div>
        <div className="mt-0.5 font-medium text-neutral-900">{reason.label}</div>
        {task.note && <p className="mt-1 text-xs text-neutral-600">{task.note}</p>}
      </div>
      <Textarea
        data-autofocus
        label={COMMON.noteLabel}
        required
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        error={noteError}
        hint={
          <span className="tabular" aria-live="polite">
            {COMMON.noteCount(trimmed, REVIEW_NOTE_MIN)}
          </span>
        }
        placeholder={C.notePlaceholder}
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
  checks,
  size = 'sm',
}: {
  task: TaskLike
  applicationId: string
  merchantName: string
  status: ApplicationStatus
  checks: CheckProgress
  size?: 'sm' | 'md'
}) {
  const [pending, setPending] = useState<ReviewResolution | null>(null)
  const offered = resolutionsFor(status, task.reason, checks)
  if (offered.length === 0) {
    return <p className="text-xs text-neutral-500">{C.noAction}</p>
  }
  const hint = approveHint(status, checks)
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {offered.map((r) => {
          const a = actionStyle(r, checks)
          return (
            <Button key={r} size={size} variant={a.variant} icon={a.icon} onClick={() => setPending(r)}>
              {resolutionLabel(r, checks)}
            </Button>
          )
        })}
      </div>
      {hint && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-neutral-500">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{hint}</span>
        </p>
      )}
      {pending && (
        <ReviewDialog
          open
          onClose={() => setPending(null)}
          applicationId={applicationId}
          merchantName={merchantName}
          task={task}
          resolution={pending}
          checks={checks}
        />
      )}
    </>
  )
}

export function TaskCard({
  task,
  applicationId,
  merchantName,
  status,
  checks,
  showApplication = true,
  app,
  currentChecks,
}: {
  task: TaskLike
  applicationId: string
  merchantName: string
  status: ApplicationStatus
  checks: CheckProgress
  showApplication?: boolean
  /** On the application page: lets a document task open the files it is about. */
  app?: ApplicationDetailDto
  /** Where the four checks stand now; shown on an open task once any check has been requested. */
  currentChecks?: CurrentCheckDto[]
}) {
  const reason = describeReason(task.reason)
  const open = task.status === 'OPEN'
  const files = app && open && DOCUMENT_TASK_REASONS.includes(task.reason) ? documentsToLookAt(app, task.note) : []
  return (
    <article className="rounded-card border border-neutral-200 bg-white p-4 shadow-card" aria-label={C.ariaTask(reason.label, merchantName)}>
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
        <time dateTime={task.created_at} title={dateTime(task.created_at)} className="text-xs text-neutral-500">
          {C.opened(relativeTime(task.created_at))}
        </time>
      </div>
      {reason.description && <p className="mt-2 text-sm text-neutral-600">{reason.description}</p>}
      {open && currentChecks?.some((c) => c.status !== null) && <ChecksNow checks={currentChecks} />}
      {task.note && (
        <div className="mt-2 rounded-control bg-neutral-50 px-3 py-2">
          <p className="text-2xs font-medium text-neutral-500">{C.atEscalation}</p>
          <p className="text-xs text-neutral-700">{task.note}</p>
        </div>
      )}
      {task.related_application_id && (
        <p className="mt-2 text-sm">
          {C.duplicateOf}{' '}
          <Link className="inline-flex items-center gap-1 font-mono text-xs text-accent-800 hover:underline" to={`/applications/${task.related_application_id}`}>
            {task.related_application_id.slice(0, 8)}
            <ExternalLink aria-hidden className="size-3" />
          </Link>
        </p>
      )}
      {files.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-neutral-500">{C.uploads}</span>
          {files.map((d) => (
            <ViewDocumentButton key={d.id} app={app!} doc={d}>
              {DOCUMENT_LABELS[d.type]}
            </ViewDocumentButton>
          ))}
        </div>
      )}
      {task.reason === 'JOB_DEAD' && open && (
        <p className="mt-2 text-sm">
          <Link to="/dead-letters" className="text-accent-800 hover:underline">
            {C.requeue}
          </Link>
        </p>
      )}
      <div className="mt-3">
        {open ? (
          <TaskActions task={task} applicationId={applicationId} merchantName={merchantName} status={status} checks={checks} />
        ) : (
          <p className="flex items-start gap-1.5 text-xs text-neutral-600">
            <Check aria-hidden className="mt-0.5 size-3.5 text-success-700" />
            <span>
              {C.resolved} <b>{task.resolution ? (RESOLUTION_LABELS[task.resolution as ReviewResolution] ?? task.resolution) : '—'}</b>
              {task.resolution_note && <> · “{task.resolution_note}”</>}
            </span>
          </p>
        )}
      </div>
    </article>
  )
}
