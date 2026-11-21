import { describeReason, STATUS_LABELS, type ApplicationStatus } from '@app/shared'
import { SEVERITY_ICON, STATUS_ICON, toneOf } from '../lib/status.ts'
import { Badge, Tooltip } from './ui.tsx'

export function StatusBadge({ status, className }: { status: ApplicationStatus; className?: string }) {
  const s = STATUS_LABELS[status]
  return (
    <Tooltip content={<span><b>{s.label}</b> ({status}): {s.description}</span>}>
      <span tabIndex={0} className="rounded-full">
        <Badge tone={toneOf(s.severity)} icon={STATUS_ICON[status]} className={className}>
          {s.label}
        </Badge>
      </span>
    </Tooltip>
  )
}

export function ReasonBadge({ reason }: { reason: string }) {
  const r = describeReason(reason)
  return (
    <Tooltip content={<span>{r.description ? `${r.description} ` : ''}<span className="font-mono">({reason})</span></span>}>
      <span tabIndex={0} className="rounded-full">
        <Badge tone={toneOf(r.severity)} icon={SEVERITY_ICON[r.severity]}>
          {r.label}
        </Badge>
      </span>
    </Tooltip>
  )
}
