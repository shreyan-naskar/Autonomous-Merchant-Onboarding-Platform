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
import { CheckProgressSchema } from './review.js';

/** Sensitive values arrive already masked by the API's response mapper; the web app never sees raw ones. */

const iso = z.string();
const masked = z.string().nullable();
const jsonValue = z.unknown();

/** Application ids are UUIDs (anything else cannot exist). */
export const APPLICATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /** Never the server path. */
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

/** A required check as it stands now: the current row's status, or null when it has not been requested. */
export const CurrentCheckDtoSchema = z.object({ kind: VerificationKindSchema, status: VerificationStatusSchema.nullable() });
export type CurrentCheckDto = z.infer<typeof CurrentCheckDtoSchema>;

export const ReviewQueueItemDtoSchema = ReviewTaskDtoSchema.extend({
  application_id: z.string(),
  merchant_name: z.string(),
  application_status: ApplicationStatusSchema,
  check_progress: CheckProgressSchema,
  /** Live, unlike the task note, which is a snapshot from when the task opened. */
  current_checks: z.array(CurrentCheckDtoSchema),
});
export type ReviewQueueItemDto = z.infer<typeof ReviewQueueItemDtoSchema>;
export const ReviewQueueDtoSchema = z.object({ items: z.array(ReviewQueueItemDtoSchema), count: z.number().int() });
export type ReviewQueueDto = z.infer<typeof ReviewQueueDtoSchema>;

/** Duplicates included, payloads never. */
export const CallbackEventDtoSchema = z.object({
  id: z.number().int(),
  event_id: z.string(),
  kind: z.string().nullable(),
  request_id: z.string().nullable(),
  received_at: iso,
  is_duplicate: z.boolean(),
  processed: z.boolean(),
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
  /** From the current rows, as the approval guard sees them: decides which review decisions are offered. */
  check_progress: CheckProgressSchema,
  review_tasks: z.array(ReviewTaskDtoSchema),
  callbacks: z.array(CallbackEventDtoSchema),
  audit_log: z.array(AuditEntryDtoSchema),
});
export type ApplicationDetailDto = z.infer<typeof ApplicationDetailDtoSchema>;

export const StateMetricDtoSchema = z.object({
  state: ApplicationStatusSchema,
  /** Completed stays only (entered and later left). */
  avg_ms: z.number().nullable(),
  completed: z.number().int(),
  current: z.number().int(),
});
export const MetricsDtoSchema = z.object({
  total_applications: z.number().int(),
  /** Applications that ever entered IN_REVIEW or NEEDS_INFO. */
  exception_count: z.number().int(),
  exception_rate: z.number(),
  states: z.array(StateMetricDtoSchema),
});
export type MetricsDto = z.infer<typeof MetricsDtoSchema>;

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
