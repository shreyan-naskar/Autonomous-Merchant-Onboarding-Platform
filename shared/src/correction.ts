import { z } from 'zod';
import { DocumentTypeSchema } from './intake.js';

/* What the merchant is asked to supply in NEEDS_INFO: the INFO_REQUIRED audit detail, rendered by the web panel. */

export const MERCHANT_FORM_FIELDS = ['merchant_name', 'pan', 'gst', 'bank_account', 'ifsc'] as const;
export const MerchantFormFieldSchema = z.enum(MERCHANT_FORM_FIELDS);
export type MerchantFormField = z.infer<typeof MerchantFormFieldSchema>;

export const FORM_FIELD_LABELS: Record<MerchantFormField, string> = {
  merchant_name: 'Business name',
  pan: 'PAN',
  gst: 'GSTIN',
  bank_account: 'Bank account number',
  ifsc: 'IFSC',
};

export const DOCUMENT_LABELS: Record<z.infer<typeof DocumentTypeSchema>, string> = {
  PAN_CARD: 'PAN card',
  GST_CERT: 'GST certificate',
  BANK_PROOF: 'Bank proof',
};

export const MERCHANT_REQUEST_CODES = ['MISSING_FIELD', 'MISSING_DOCUMENT', 'MISSING_VALUE'] as const;

/** One thing to supply, in plain language. Never contains PAN / GSTIN / account values. */
export const MerchantRequestSchema = z.object({
  code: z.enum(MERCHANT_REQUEST_CODES),
  document: DocumentTypeSchema.optional(),
  field: z.string().optional(),
  message: z.string(),
});
export type MerchantRequest = z.infer<typeof MerchantRequestSchema>;

export const InfoRequestDetailSchema = z.object({
  reason: z.literal('MISSING_INFO'),
  missing: z.array(z.string()),
  requests: z.array(MerchantRequestSchema),
  form_fields: z.array(MerchantFormFieldSchema),
  documents: z.array(DocumentTypeSchema),
});
export type InfoRequestDetail = z.infer<typeof InfoRequestDetailSchema>;
