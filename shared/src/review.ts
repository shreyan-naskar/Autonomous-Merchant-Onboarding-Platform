import { z } from 'zod';
import { APPLICATION_STATUSES, type ApplicationStatus, type VerificationStatus } from './domain.js';

/** DISMISS changes no state; it is refused in IN_REVIEW so an application is never left under review with nothing to act on. */
export const REVIEW_RESOLUTIONS = [
  'APPROVE',
  'REJECT',
  'REQUEST_INFO',
  'RETRY_VERIFICATION',
  'RETRY_MERCHANT_CREATION',
  'DISMISS',
] as const;
export const ReviewResolutionSchema = z.enum(REVIEW_RESOLUTIONS);
export type ReviewResolution = z.infer<typeof ReviewResolutionSchema>;

/** Narrower than ALLOWED_TRANSITIONS on purpose: IN_REVIEW -> APPROVED is legal, but only APPROVE may take it. API and UI share it. */
export const REVIEW_RESOLUTION_FROM: Record<ReviewResolution, readonly ApplicationStatus[]> = {
  APPROVE: ['VERIFIED', 'IN_REVIEW'],
  REJECT: ['IN_REVIEW'],
  REQUEST_INFO: ['IN_REVIEW'],
  RETRY_VERIFICATION: ['IN_REVIEW'],
  RETRY_MERCHANT_CREATION: ['MERCHANT_CREATION_FAILED'],
  DISMISS: APPLICATION_STATUSES.filter((s) => s !== 'IN_REVIEW'),
};

export const INFORMATIONAL_TASK_REASONS: readonly string[] = ['POSSIBLE_DUPLICATE'];

/**
 * Where the four required checks stand, from each one's current row:
 * NOT_STARTED (the application stopped before verification, e.g. at the
 * document step), INCOMPLETE (some pending, failed or timed out), ALL_PASSED.
 */
export const CHECK_PROGRESSES = ['NOT_STARTED', 'INCOMPLETE', 'ALL_PASSED'] as const;
export const CheckProgressSchema = z.enum(CHECK_PROGRESSES);
export type CheckProgress = z.infer<typeof CheckProgressSchema>;

export function checkProgress(current: readonly (VerificationStatus | undefined)[]): CheckProgress {
  if (current.every((s) => s === undefined)) return 'NOT_STARTED';
  return current.every((s) => s === 'PASSED') ? 'ALL_PASSED' : 'INCOMPLETE';
}

/**
 * The decisions worth offering on a task. APPROVE only once every check has
 * passed: the approval guard refuses it otherwise, so offering it would only
 * lead to a "can't approve yet" error.
 */
export function resolutionsFor(status: ApplicationStatus, taskReason: string, checks: CheckProgress): ReviewResolution[] {
  const offered = REVIEW_RESOLUTIONS.filter(
    (r) =>
      REVIEW_RESOLUTION_FROM[r].includes(status) &&
      (r !== 'DISMISS' || INFORMATIONAL_TASK_REASONS.includes(taskReason)) &&
      (r !== 'APPROVE' || checks === 'ALL_PASSED'),
  );
  // Before any check has run, accepting the documents is the way forward.
  return checks === 'NOT_STARTED' && offered.includes('RETRY_VERIFICATION')
    ? ['RETRY_VERIFICATION', ...offered.filter((r) => r !== 'RETRY_VERIFICATION')]
    : offered;
}

export const REVIEW_NOTE_MIN = 5;

/** Every operator action carries a note (stored redacted, and in the audit detail). */
const NOTE_REQUIRED = `Note is required (at least ${REVIEW_NOTE_MIN} characters)`;
export const OperatorNoteSchema = z.string({ error: NOTE_REQUIRED }).trim().min(REVIEW_NOTE_MIN, NOTE_REQUIRED).max(2000);

export const ReviewRequestSchema = z.strictObject({
  taskId: z.number().int().positive(),
  resolution: ReviewResolutionSchema,
  note: OperatorNoteSchema,
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const MerchantServiceConfigSchema = z.strictObject({ fail: z.boolean() });
export type MerchantServiceConfig = z.infer<typeof MerchantServiceConfigSchema>;

export const MERCHANT_ID_RE = /^MID-[A-Z0-9]{8}$/;

export const RequeueJobRequestSchema = z.strictObject({ note: OperatorNoteSchema });
export type RequeueJobRequest = z.infer<typeof RequeueJobRequestSchema>;
