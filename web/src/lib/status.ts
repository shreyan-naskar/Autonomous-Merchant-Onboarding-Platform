import {
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
