import {
  REVIEW_NOTE_MIN,
  REVIEW_RESOLUTIONS,
  REVIEW_RESOLUTION_FROM,
  type ApplicationStatus,
  type ReviewResolution,
} from '@app/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api.ts'
import { ErrorBox, buttonClass, inputClass } from './ui.tsx'

const LABEL: Record<ReviewResolution, string> = {
  APPROVE: 'Approve',
  REJECT: 'Reject',
  REQUEST_INFO: 'Request info',
  RETRY_VERIFICATION: 'Retry verification',
  RETRY_MERCHANT_CREATION: 'Retry merchant creation',
}

/**
 * Operator decision on one open task: a required note plus one button per
 * resolution the API accepts from the application's current state
 * (REVIEW_RESOLUTION_FROM, shared with the API). Errors, including the 409
 * approval-guard message, are shown inline.
 */
export function ReviewActions({ applicationId, taskId, status }: { applicationId: string; taskId: number; status: ApplicationStatus }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const resolve = useMutation({
    mutationFn: (resolution: ReviewResolution) =>
      api.post(`/applications/${applicationId}/review`, { taskId, resolution, note }),
    onSuccess: () => {
      setNote('')
      return qc.invalidateQueries()
    },
  })
  const offered = REVIEW_RESOLUTIONS.filter((r) => REVIEW_RESOLUTION_FROM[r].includes(status))
  const noteOk = note.trim().length >= REVIEW_NOTE_MIN

  if (offered.length === 0) {
    return <p className="mt-2 text-xs text-slate-500">No operator action while the application is {status}.</p>
  }
  return (
    <div className="mt-2 space-y-2">
      <label className="block text-xs text-slate-600">
        Note (required, at least {REVIEW_NOTE_MIN} characters)
        <textarea className={inputClass} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        {offered.map((r) => (
          <button
            key={r}
            type="button"
            className={r === 'APPROVE' || r === 'RETRY_MERCHANT_CREATION' ? buttonClass.primary : buttonClass.secondary}
            disabled={!noteOk || resolve.isPending}
            onClick={() => resolve.mutate(r)}
          >
            {LABEL[r]}
          </button>
        ))}
      </div>
      <ErrorBox error={resolve.error} />
    </div>
  )
}
