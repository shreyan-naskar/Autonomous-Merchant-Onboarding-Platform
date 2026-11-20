import { z } from 'zod';

/**
 * Domain vocabulary shared by api and web. The API's `transition()` is the
 * only writer of application status and enforces ALLOWED_TRANSITIONS; the
 * web app uses the same map to decide which operator actions to offer.
 */

export const APPLICATION_STATUSES = [
  'SUBMITTED',
  'EXTRACTING',
  'NEEDS_INFO',
  'VERIFYING',
  'IN_REVIEW',
  'VERIFIED',
  'APPROVED',
  'MERCHANT_CREATED',
  'MERCHANT_CREATION_FAILED',
  'REJECTED',
] as const;
export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

/** Every legal edge. Anything not listed here is rejected by `transition()`. */
export const ALLOWED_TRANSITIONS = {
  SUBMITTED: ['EXTRACTING'],
  EXTRACTING: ['NEEDS_INFO', 'VERIFYING', 'IN_REVIEW'],
  NEEDS_INFO: ['EXTRACTING'],
  VERIFYING: ['VERIFIED', 'IN_REVIEW', 'REJECTED'],
  VERIFIED: ['APPROVED', 'IN_REVIEW'],
  IN_REVIEW: ['VERIFYING', 'APPROVED', 'REJECTED', 'NEEDS_INFO'],
  APPROVED: ['MERCHANT_CREATED', 'MERCHANT_CREATION_FAILED'],
  MERCHANT_CREATION_FAILED: ['APPROVED'],
  MERCHANT_CREATED: [],
  REJECTED: [],
} as const satisfies Record<ApplicationStatus, readonly ApplicationStatus[]>;

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] as readonly ApplicationStatus[]).includes(to);
}

export function isTerminal(status: ApplicationStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

/** Who caused an audit entry. */
export const ACTORS = ['system', 'operator', 'provider', 'merchant'] as const;
export const ActorSchema = z.enum(ACTORS);
export type Actor = z.infer<typeof ActorSchema>;

/**
 * Audit event names. Transition events and non-transition events (late or
 * duplicate callbacks, job failures) share one log.
 */
export const AUDIT_EVENTS = [
  'APPLICATION_SUBMITTED',
  'APPLICATION_UPDATED',
  'EXTRACTION_STARTED',
  'INFO_REQUIRED',
  'INFO_SUPPLIED',
  'DOC_CONFLICT',
  'LOW_CONFIDENCE',
  'VERIFICATION_STARTED',
  'VERIFICATION_RESULT',
  'VERIFICATION_TIMED_OUT',
  'VERIFICATION_FAILED',
  'ALL_CHECKS_PASSED',
  'LATE_CALLBACK',
  'STALE_CALLBACK',
  'DUPLICATE_CALLBACK',
  'HIGH_RISK',
  'BANK_CHANGED',
  'AUTO_APPROVED',
  'OPERATOR_APPROVED',
  'OPERATOR_REJECTED',
  'OPERATOR_REQUESTED_INFO',
  'OPERATOR_REVERIFY',
  'MERCHANT_CREATED',
  'MERCHANT_CREATION_FAILED',
  'MERCHANT_CREATION_RETRY',
  'JOB_FAILED',
  'JOB_DEAD',
] as const;
export const AuditEventSchema = z.enum(AUDIT_EVENTS);
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const VERIFICATION_KINDS = ['PAN', 'GST', 'BANK', 'RISK'] as const;
export const VerificationKindSchema = z.enum(VERIFICATION_KINDS);
export type VerificationKind = z.infer<typeof VerificationKindSchema>;

/** Checks that must be PASSED (for the current bank_version) before APPROVED. */
export const REQUIRED_CHECKS: readonly VerificationKind[] = VERIFICATION_KINDS;

export const VERIFICATION_STATUSES = ['PENDING', 'PASSED', 'FAILED', 'TIMED_OUT'] as const;
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const VALIDATION_STATUSES = ['ok', 'mismatch', 'missing', 'low_confidence'] as const;
export const ValidationStatusSchema = z.enum(VALIDATION_STATUSES);
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>;

export const REVIEW_TASK_STATUSES = ['OPEN', 'RESOLVED'] as const;
export const ReviewTaskStatusSchema = z.enum(REVIEW_TASK_STATUSES);
export type ReviewTaskStatus = z.infer<typeof ReviewTaskStatusSchema>;

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'dead'] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Background job types handled by the API worker. */
export const JOB_TYPES = [
  'extract',
  'start_verifications',
  'verification_timeout',
  'approve',
  'create_merchant',
] as const;
export const JobTypeSchema = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobTypeSchema>;
