import { z } from 'zod';
import {
  ActorSchema,
  ApplicationStatusSchema,
  JobStatusSchema,
  ReviewTaskStatusSchema,
  ValidationStatusSchema,
  VerificationKindSchema,
  VerificationStatusSchema,
} from './domain.js';
import { DocumentTypeSchema } from './intake.js';

/**
 * Response DTOs. Sensitive values (pan, gst, bank_account and the same keys
 * inside document payloads / audit details) are always masked to the last 4
 * characters by the API's response mapper; the web app only ever sees these.
 * Timestamps are ISO-8601 strings.
 */

const iso = z.string();
/** Masked value, e.g. "******234F". */
const masked = z.string().nullable();
const jsonValue = z.unknown();

export const ApplicationSummaryDtoSchema = z.object({
  id: z.string(),
  status: ApplicationStatusSchema,
  merchant_name: z.string(),
  pan: masked,
  gst: masked,
  bank_account: masked,
  ifsc: z.string().nullable(),
  bank_version: z.number().int(),
  merchant_id: z.string().nullable(),
  created_at: iso,
  updated_at: iso,
  state_entered_at: iso,
  time_in_state_ms: z.number().int(),
  open_review_count: z.number().int(),
});
export type ApplicationSummaryDto = z.infer<typeof ApplicationSummaryDtoSchema>;

export const ApplicationListDtoSchema = z.object({
  items: z.array(ApplicationSummaryDtoSchema),
  count: z.number().int(),
});
export type ApplicationListDto = z.infer<typeof ApplicationListDtoSchema>;

export const DocumentDtoSchema = z.object({
  id: z.number().int(),
  type: DocumentTypeSchema,
  /** Stored file name for uploads (no server path); null for JSON documents. */
  file_name: z.string().nullable(),
  payload: jsonValue,
  blur_score: z.number().nullable(),
  created_at: iso,
});

export const ExtractedFieldDtoSchema = z.object({
  id: z.number().int(),
  document_id: z.number().int().nullable(),
  field: z.string(),
  value: z.string().nullable(),
  confidence: z.number(),
  validation_status: ValidationStatusSchema,
});

export const VerificationDtoSchema = z.object({
  id: z.number().int(),
  kind: VerificationKindSchema,
  status: VerificationStatusSchema,
  attempt: z.number().int(),
  bank_version: z.number().int(),
  superseded: z.boolean(),
  /** The row that counts for this kind now (what evaluate() and the approval guard use). */
  is_current: z.boolean(),
  score: z.number().nullable(),
  requested_at: iso,
  completed_at: iso.nullable(),
});

export const ReviewTaskDtoSchema = z.object({
  id: z.number().int(),
  reason: z.string(),
  status: ReviewTaskStatusSchema,
  resolution: z.string().nullable(),
  note: z.string().nullable(),
  resolution_note: z.string().nullable(),
  /** The other application a POSSIBLE_DUPLICATE task points at. */
  related_application_id: z.string().nullable(),
  created_at: iso,
  resolved_at: iso.nullable(),
});

/** Review queue row: a task plus enough of its application to act on it. */
export const ReviewQueueItemDtoSchema = ReviewTaskDtoSchema.extend({
  application_id: z.string(),
  merchant_name: z.string(),
  application_status: ApplicationStatusSchema,
});
export type ReviewQueueItemDto = z.infer<typeof ReviewQueueItemDtoSchema>;
export const ReviewQueueDtoSchema = z.object({ items: z.array(ReviewQueueItemDtoSchema), count: z.number().int() });
export type ReviewQueueDto = z.infer<typeof ReviewQueueDtoSchema>;

/** Provider callbacks received for the application (duplicates included). No payload. */
export const CallbackEventDtoSchema = z.object({
  id: z.number().int(),
  event_id: z.string(),
  kind: z.string().nullable(),
  request_id: z.string().nullable(),
  received_at: iso,
  is_duplicate: z.boolean(),
  processed: z.boolean(),
  /** Outcome: applied, late, stale, already_completed, mismatch, unknown_request, duplicate ignored. */
  note: z.string().nullable(),
});
export type CallbackEventDto = z.infer<typeof CallbackEventDtoSchema>;

export const AuditEntryDtoSchema = z.object({
  id: z.number().int(),
  at: iso,
  actor: ActorSchema,
  from_state: ApplicationStatusSchema.nullable(),
  to_state: ApplicationStatusSchema.nullable(),
  event: z.string(),
  detail: jsonValue,
});

export const ApplicationDetailDtoSchema = ApplicationSummaryDtoSchema.extend({
  documents: z.array(DocumentDtoSchema),
  extracted_fields: z.array(ExtractedFieldDtoSchema),
  verifications: z.array(VerificationDtoSchema),
  review_tasks: z.array(ReviewTaskDtoSchema),
  callbacks: z.array(CallbackEventDtoSchema),
  audit_log: z.array(AuditEntryDtoSchema),
});
export type ApplicationDetailDto = z.infer<typeof ApplicationDetailDtoSchema>;

/** `GET /metrics`, computed from audit_log. */
export const StateMetricDtoSchema = z.object({
  state: ApplicationStatusSchema,
  /** Mean duration of completed stays in this state (entered and later left); null if none. */
  avg_ms: z.number().nullable(),
  /** Number of completed stays averaged. */
  completed: z.number().int(),
  /** Applications in this state right now. */
  current: z.number().int(),
});
export const MetricsDtoSchema = z.object({
  total_applications: z.number().int(),
  /** Applications that ever entered IN_REVIEW or NEEDS_INFO. */
  exception_count: z.number().int(),
  /** exception_count / total_applications (0 when there are none). */
  exception_rate: z.number(),
  states: z.array(StateMetricDtoSchema),
});
export type MetricsDto = z.infer<typeof MetricsDtoSchema>;

/** Dead-letter view row: a `dead` job. Payload masked like every other response. */
export const DeadJobDtoSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  status: JobStatusSchema,
  payload: z.unknown(),
  application_id: z.string().nullable(),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  last_error: z.string().nullable(),
  run_at: iso,
  created_at: iso,
  updated_at: iso,
});
export type DeadJobDto = z.infer<typeof DeadJobDtoSchema>;
export const DeadJobListDtoSchema = z.object({ items: z.array(DeadJobDtoSchema), count: z.number().int() });
export type DeadJobListDto = z.infer<typeof DeadJobListDtoSchema>;
