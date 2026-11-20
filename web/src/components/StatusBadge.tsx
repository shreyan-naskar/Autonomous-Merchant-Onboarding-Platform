import type { ApplicationStatus } from '@app/shared'

/** One color per state; typed against the shared enum so a new state cannot be missed. */
const STATUS_STYLE: Record<ApplicationStatus, string> = {
  SUBMITTED: 'bg-slate-100 text-slate-700 ring-slate-300',
  EXTRACTING: 'bg-sky-100 text-sky-800 ring-sky-300',
  NEEDS_INFO: 'bg-amber-100 text-amber-800 ring-amber-300',
  VERIFYING: 'bg-blue-100 text-blue-800 ring-blue-300',
  IN_REVIEW: 'bg-orange-100 text-orange-800 ring-orange-300',
  VERIFIED: 'bg-teal-100 text-teal-800 ring-teal-300',
  APPROVED: 'bg-lime-100 text-lime-800 ring-lime-300',
  MERCHANT_CREATED: 'bg-green-100 text-green-800 ring-green-400',
  MERCHANT_CREATION_FAILED: 'bg-fuchsia-100 text-fuchsia-800 ring-fuchsia-300',
  REJECTED: 'bg-red-100 text-red-800 ring-red-300',
}

export function StatusBadge({ status }: { status: ApplicationStatus }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 font-mono text-xs font-semibold ring-1 ring-inset ${STATUS_STYLE[status]}`}>
      {status}
    </span>
  )
}
