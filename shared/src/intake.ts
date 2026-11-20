import { z } from 'zod';

/**
 * Request schemas for application intake. Error messages are fixed strings:
 * they never include the submitted value, so a 400 cannot echo a PAN or
 * account number back to the caller (or into logs).
 */

// Format rules, reused by the Phase 3 validators.
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
/** 2-digit state code, PAN, entity number, 'Z', checksum. */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const BANK_ACCOUNT_RE = /^[0-9]{9,18}$/;

export const DOCUMENT_TYPES = ['PAN_CARD', 'GST_CERT', 'BANK_PROOF'] as const;
export const DocumentTypeSchema = z.enum(DOCUMENT_TYPES);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

/** Accepted upload MIME types and the extension used when saving them. */
export const UPLOAD_MIME_TYPES = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
} as const;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Form fields (what the merchant typed). Strictly validated at intake.

const merchantName = z.string().trim().min(2, 'Must be at least 2 characters').max(200, 'Must be at most 200 characters');
const pan = z.string().trim().toUpperCase().regex(PAN_RE, 'PAN must be 5 letters, 4 digits, 1 letter');
const gst = z.string().trim().toUpperCase().regex(GSTIN_RE, 'GSTIN must be a 15-character GST number');
const bankAccount = z.string().trim().regex(BANK_ACCOUNT_RE, 'Bank account must be 9-18 digits');
const ifsc = z.string().trim().toUpperCase().regex(IFSC_RE, 'IFSC must be 4 letters, 0, then 6 letters/digits');

export const ApplicationFieldsSchema = z.strictObject({
  merchant_name: merchantName,
  pan: pan.optional(),
  gst: gst.optional(),
  bank_account: bankAccount.optional(),
  ifsc: ifsc.optional(),
});
export type ApplicationFields = z.infer<typeof ApplicationFieldsSchema>;

// ---------------------------------------------------------------------------
// Structured documents. Payload values are what the document "says"; they are
// deliberately loose (any short string) because checking them against formats
// and the form is the extraction step's job (Phase 3), which turns problems
// into review outcomes instead of 400s.

const docValue = z.string().trim().min(1, 'Must not be empty').max(200, 'Must be at most 200 characters').optional();

export const PanCardPayloadSchema = z.strictObject({ pan: docValue, name: docValue, dob: docValue });
export const GstCertPayloadSchema = z.strictObject({ gstin: docValue, legal_name: docValue, address: docValue });
export const BankProofPayloadSchema = z.strictObject({
  account_number: docValue,
  ifsc: docValue,
  account_holder: docValue,
});

export const StructuredDocumentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('PAN_CARD'), payload: PanCardPayloadSchema }),
  z.strictObject({ type: z.literal('GST_CERT'), payload: GstCertPayloadSchema }),
  z.strictObject({ type: z.literal('BANK_PROOF'), payload: BankProofPayloadSchema }),
]);
export type StructuredDocument = z.infer<typeof StructuredDocumentSchema>;

const uniqueTypes = (docs: { type: string }[]) => new Set(docs.map((d) => d.type)).size === docs.length;

export const StructuredDocumentListSchema = z
  .array(StructuredDocumentSchema)
  .max(DOCUMENT_TYPES.length, `At most ${DOCUMENT_TYPES.length} documents`)
  .refine(uniqueTypes, 'Each document type may appear at most once');

/** POST /applications with `content-type: application/json`. */
export const CreateApplicationJsonSchema = ApplicationFieldsSchema.extend({
  documents: StructuredDocumentListSchema.default([]),
});
export type CreateApplicationJson = z.infer<typeof CreateApplicationJsonSchema>;

/**
 * POST /applications as multipart/form-data: the same text fields, files in
 * parts named after their document type (PAN_CARD, GST_CERT, BANK_PROOF), and
 * optionally a `documents` part holding a JSON array of structured documents.
 */
const jsonText = z.string().transform((s, ctx) => {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    // Never surface JSON.parse's message: V8 quotes the offending input.
    ctx.addIssue({ code: 'custom', message: 'Must be a JSON array of documents' });
    return z.NEVER;
  }
});
export const CreateApplicationMultipartFieldsSchema = ApplicationFieldsSchema.extend({
  documents: jsonText.pipe(StructuredDocumentListSchema).optional(),
});

/**
 * PATCH /applications/:id. Any subset of the form fields and/or structured
 * documents (documents are only accepted while the application is in
 * NEEDS_INFO; each replaces the existing document of the same type).
 */
export const UpdateApplicationSchema = ApplicationFieldsSchema.partial()
  .extend({ documents: StructuredDocumentListSchema.optional() })
  .refine(
    (v) => Object.entries(v).some(([k, x]) => x !== undefined && !(k === 'documents' && (x as unknown[]).length === 0)),
    'Provide at least one field to update',
  );
export type UpdateApplication = z.infer<typeof UpdateApplicationSchema>;

export const ListApplicationsQuerySchema = z.strictObject({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
