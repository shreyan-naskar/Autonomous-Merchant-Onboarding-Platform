import {
  describeReason,
  STATUS_LABELS,
  type ApplicationStatus,
  type Severity,
} from '@app/shared'
import {
  AlertOctagon,
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  CircleDashed,
  FileQuestion,
  Hourglass,
  Info,
  ScanText,
  ShieldCheck,
  UserRoundSearch,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { Badge, Tooltip, type Tone } from '../components/ui.tsx'

/*
 * Web side of the plain-language mapping (shared/src/labels.ts holds the
 * words): severity -> tone and icon, so status is never color-only.
 */

export const toneOf = (s: Severity): Tone => s

export const SEVERITY_ICON: Record<Severity, LucideIcon> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
  neutral: CircleDashed,
}

export const STATUS_ICON: Record<ApplicationStatus, LucideIcon> = {
  SUBMITTED: CircleDashed,
  EXTRACTING: ScanText,
  NEEDS_INFO: FileQuestion,
  VERIFYING: Hourglass,
  IN_REVIEW: UserRoundSearch,
  VERIFIED: ShieldCheck,
  APPROVED: BadgeCheck,
  MERCHANT_CREATED: CheckCircle2,
  MERCHANT_CREATION_FAILED: AlertOctagon,
  REJECTED: XCircle,
}

/** Status as icon + plain words; the raw code and a one-line explanation in the tooltip. */
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

/** A review task reason in plain words; raw code in the tooltip. */
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

/** Applications that need someone to act. */
export const NEEDS_ATTENTION: readonly ApplicationStatus[] = ['NEEDS_INFO', 'IN_REVIEW', 'MERCHANT_CREATION_FAILED']
