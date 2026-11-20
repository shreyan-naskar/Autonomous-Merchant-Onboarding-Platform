import { z } from 'zod';

/**
 * Operator resolutions for `POST /applications/:id/review`. Each maps to one
 * transition (the source state must allow it):
 * - APPROVE: VERIFIED | IN_REVIEW -> APPROVED (approval guard applies)
 * - REJECT: IN_REVIEW -> REJECTED
 * - REQUEST_INFO: IN_REVIEW -> NEEDS_INFO
 * - RETRY_VERIFICATION: IN_REVIEW -> VERIFYING (re-runs checks that have not passed; all four if every check passed)
 * - RETRY_MERCHANT_CREATION: MERCHANT_CREATION_FAILED -> APPROVED (re-enqueues create_merchant)
 */
export const REVIEW_RESOLUTIONS = [
  'APPROVE',
  'REJECT',
  'REQUEST_INFO',
  'RETRY_VERIFICATION',
  'RETRY_MERCHANT_CREATION',
] as const;
export const ReviewResolutionSchema = z.enum(REVIEW_RESOLUTIONS);
export type ReviewResolution = z.infer<typeof ReviewResolutionSchema>;

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
