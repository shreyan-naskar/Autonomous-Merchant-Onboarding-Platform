import { z } from 'zod';
import { APPLICATION_STATUSES, type ApplicationStatus } from './domain.js';

/**
 * Operator resolutions for `POST /applications/:id/review`. Each maps to one
 * transition (the source state must allow it):
 * - APPROVE: VERIFIED | IN_REVIEW -> APPROVED (approval guard applies)
 * - REJECT: IN_REVIEW -> REJECTED
 * - REQUEST_INFO: IN_REVIEW -> NEEDS_INFO
 * - RETRY_VERIFICATION: IN_REVIEW -> VERIFYING (re-runs checks that have not passed; all four if every check passed)
 * - RETRY_MERCHANT_CREATION: MERCHANT_CREATION_FAILED -> APPROVED (re-enqueues create_merchant)
 * - DISMISS: no transition; closes an informational task (POSSIBLE_DUPLICATE)
 *   that turned out to be harmless. Any state except IN_REVIEW (there, one of
 *   the decisions above resolves it, so the app is never left under review
 *   with nothing to act on).
 */
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

/**
 * States each resolution may be used from. Narrower than ALLOWED_TRANSITIONS
 * on purpose: IN_REVIEW -> APPROVED is legal, but only APPROVE may take it.
 * The API enforces this; the UI uses it to decide which buttons to show.
 */
export const REVIEW_RESOLUTION_FROM: Record<ReviewResolution, readonly ApplicationStatus[]> = {
  APPROVE: ['VERIFIED', 'IN_REVIEW'],
  REJECT: ['IN_REVIEW'],
  REQUEST_INFO: ['IN_REVIEW'],
  RETRY_VERIFICATION: ['IN_REVIEW'],
  RETRY_MERCHANT_CREATION: ['MERCHANT_CREATION_FAILED'],
  DISMISS: APPLICATION_STATUSES.filter((s) => s !== 'IN_REVIEW'),
};

/** Review task reasons that do not come with a state of their own; only these can be dismissed. */
export const INFORMATIONAL_TASK_REASONS: readonly string[] = ['POSSIBLE_DUPLICATE'];

/**
 * Resolutions offered for one task: allowed from the application's state,
 * and DISMISS only for informational tasks. The API enforces the same rule.
 */
export function resolutionsFor(status: ApplicationStatus, taskReason: string): ReviewResolution[] {
  return REVIEW_RESOLUTIONS.filter(
    (r) => REVIEW_RESOLUTION_FROM[r].includes(status) && (r !== 'DISMISS' || INFORMATIONAL_TASK_REASONS.includes(taskReason)),
  );
}

export const REVIEW_NOTE_MIN = 5;

export const ReviewRequestSchema = z.strictObject({
  taskId: z.number().int().positive(),
  resolution: ReviewResolutionSchema,
  note: z
    .string()
    .trim()
    .min(REVIEW_NOTE_MIN, `Note is required (at least ${REVIEW_NOTE_MIN} characters)`)
    .max(2000),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

/** `POST /admin/merchant-service`: toggle the simulated merchant ID service's failure mode. */
export const MerchantServiceConfigSchema = z.strictObject({ fail: z.boolean() });
export type MerchantServiceConfig = z.infer<typeof MerchantServiceConfigSchema>;

/** Merchant IDs issued by the internal service: `MID-` + 8 uppercase alphanumerics. */
export const MERCHANT_ID_RE = /^MID-[A-Z0-9]{8}$/;
