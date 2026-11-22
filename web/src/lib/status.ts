import {
  VERIFICATION_KINDS,
  type ApplicationDetailDto,
  type ApplicationStatus,
  type CurrentCheckDto,
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
import type { Tone } from './tone.ts'



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

export const NEEDS_ATTENTION: readonly ApplicationStatus[] = ['NEEDS_INFO', 'IN_REVIEW', 'MERCHANT_CREATION_FAILED']

/** Each required check as the application's current verification rows have it now (null: not requested). */
export function currentChecksOf(app: Pick<ApplicationDetailDto, 'verifications'>): CurrentCheckDto[] {
  return VERIFICATION_KINDS.map((kind) => ({ kind, status: app.verifications.find((v) => v.kind === kind && v.is_current)?.status ?? null }))
}
