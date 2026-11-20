import { z } from 'zod';
import {
  ActorSchema,
  ApplicationStatusSchema,
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
  created_at: iso,
  resolved_at: iso.nullable(),
});

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
  audit_log: z.array(AuditEntryDtoSchema),
});
export type ApplicationDetailDto = z.infer<typeof ApplicationDetailDtoSchema>;
