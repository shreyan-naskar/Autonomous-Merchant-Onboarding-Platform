import {
  DOCUMENT_TYPES,
  gstinMatchesPan,
  isValidBankAccount,
  isValidGstin,
  isValidIfsc,
  isValidPan,
  nameSimilarity,
  type DocumentType,
  type ValidationStatus,
} from '@app/shared';
import type { DocumentReading } from './read.js';

/* Pure: form values + documents in, one row per expected field plus what is missing out. */

export const REQUIRED_DOCUMENTS: readonly DocumentType[] = DOCUMENT_TYPES;

export const REQUIRED_FORM_FIELDS = ['pan', 'gst', 'bank_account', 'ifsc'] as const;
export type FormField = (typeof REQUIRED_FORM_FIELDS)[number];

export const STRUCTURED_CONFIDENCE = 1.0;
/** Below the default 0.8 threshold, so a malformed value goes to review. */
export const FORMAT_FAIL_CONFIDENCE = 0.5;
export const UNREADABLE_CONFIDENCE = 0;

type ValueKind = 'pan' | 'gstin' | 'bank_account' | 'ifsc' | 'name';

interface FieldSpec {
  key: string;
  /** pan / gst / bank_account are masked by this name in every response. */
  field: string;
  kind: ValueKind;
}

export const DOCUMENT_FIELDS: Record<DocumentType, readonly FieldSpec[]> = {
  PAN_CARD: [
    { key: 'pan', field: 'pan', kind: 'pan' },
    { key: 'name', field: 'name', kind: 'name' },
  ],
  GST_CERT: [
    { key: 'gstin', field: 'gst', kind: 'gstin' },
    { key: 'legal_name', field: 'legal_name', kind: 'name' },
  ],
  BANK_PROOF: [
    { key: 'account_number', field: 'bank_account', kind: 'bank_account' },
    { key: 'ifsc', field: 'ifsc', kind: 'ifsc' },
    { key: 'account_holder', field: 'account_holder', kind: 'name' },
  ],
};

const FORMAT_CHECKS: Record<Exclude<ValueKind, 'name'>, (v: string) => boolean> = {
  pan: isValidPan,
  gstin: isValidGstin,
  bank_account: isValidBankAccount,
  ifsc: isValidIfsc,
};

export type FieldIssue =
  | 'missing'
  | 'unreadable'
  | 'blurry'
  | 'invalid_format'
  | 'differs_from_form'
  | 'gstin_pan_mismatch'
  | 'name_mismatch';

export interface ExtractedFieldResult {
  documentType: DocumentType;
  documentId: number;
  sourceKey: string;
  field: string;
  value: string | null;
  confidence: number;
  validationStatus: ValidationStatus;
  issue?: FieldIssue;
  similarity?: number;
}

export interface BlurryDocument {
  documentType: DocumentType;
  documentId: number;
  blurScore: number;
}

export interface ExtractionResult {
  fields: ExtractedFieldResult[];
  blurryDocuments: BlurryDocument[];
  missingDocuments: DocumentType[];
  missingFormFields: FormField[];
}

export interface ExtractionForm {
  merchantName: string;
  pan: string | null;
  gst: string | null;
  bankAccount: string | null;
  ifsc: string | null;
}

export interface ExtractionDocument {
  id: number;
  type: string;
  payload: unknown;
  path: string | null;
  reading?: DocumentReading;
}

const FORM_KEY: Record<FormField, keyof ExtractionForm> = {
  pan: 'pan',
  gst: 'gst',
  bank_account: 'bankAccount',
  ifsc: 'ifsc',
};

function readValue(payload: Record<string, unknown>, spec: FieldSpec): string | null {
  const raw = payload[spec.key];
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  return spec.kind === 'name' ? s : s.toUpperCase();
}

function compareWithForm(
  spec: FieldSpec,
  value: string,
  form: ExtractionForm,
  docPan: string | null,
  nameThreshold: number,
): { issue?: FieldIssue; similarity?: number } {
  switch (spec.kind) {
    case 'name': {
      const similarity = Math.round(nameSimilarity(value, form.merchantName) * 1000) / 1000;
      return similarity >= nameThreshold ? { similarity } : { issue: 'name_mismatch', similarity };
    }
    case 'pan':
      return form.pan && value !== form.pan ? { issue: 'differs_from_form' } : {};
    case 'gstin': {
      if (form.gst && value !== form.gst) return { issue: 'differs_from_form' };
      // The GSTIN must embed the applicant's PAN (form PAN, else the PAN card's).
      const pan = form.pan ?? docPan;
      return pan && !gstinMatchesPan(value, pan) ? { issue: 'gstin_pan_mismatch' } : {};
    }
    case 'bank_account':
      return form.bankAccount && value !== form.bankAccount ? { issue: 'differs_from_form' } : {};
    case 'ifsc':
      return form.ifsc && value !== form.ifsc ? { issue: 'differs_from_form' } : {};
  }
}

/**
 * Per field, first match wins: blurry image, absent, unreadable upload,
 * bad format (0.5), differs from the form (`mismatch`), else `ok`. Values read
 * from a file carry the read's confidence instead of 1.0, so a poor read
 * reaches review through the normal confidence threshold.
 */
export function extractFields(
  form: ExtractionForm,
  docs: readonly ExtractionDocument[],
  { nameThreshold }: { nameThreshold: number },
): ExtractionResult {
  const byType = new Map<DocumentType, ExtractionDocument>();
  for (const d of docs) {
    if ((DOCUMENT_TYPES as readonly string[]).includes(d.type) && !byType.has(d.type as DocumentType)) {
      byType.set(d.type as DocumentType, d);
    }
  }

  const payloadOf = (d: ExtractionDocument | undefined): Record<string, unknown> | null =>
    d?.payload && typeof d.payload === 'object'
      ? (d.payload as Record<string, unknown>)
      : (d?.reading?.payload ?? null);

  const panPayload = payloadOf(byType.get('PAN_CARD'));
  const docPan = panPayload ? readValue(panPayload, DOCUMENT_FIELDS.PAN_CARD[0]!) : null;

  const fields: ExtractedFieldResult[] = [];
  const blurryDocuments: BlurryDocument[] = [];
  for (const type of DOCUMENT_TYPES) {
    const doc = byType.get(type);
    if (!doc) continue;
    const structured = doc.payload && typeof doc.payload === 'object';
    const payload = payloadOf(doc);
    const fromFile = !structured && payload !== null;
    const sourceConfidence = fromFile ? doc.reading!.confidence : STRUCTURED_CONFIDENCE;
    const confidenceOf = (key: string) => (fromFile ? (doc.reading!.fieldConfidence?.[key] ?? sourceConfidence) : sourceConfidence);
    const blurry = !structured && doc.reading?.blurry === true;
    if (blurry) blurryDocuments.push({ documentType: type, documentId: doc.id, blurScore: doc.reading!.blurScore! });

    for (const spec of DOCUMENT_FIELDS[type]) {
      const base = { documentType: type, documentId: doc.id, sourceKey: spec.key, field: spec.field };

      if (blurry) {
        fields.push({ ...base, value: null, confidence: 0, validationStatus: 'low_confidence', issue: 'blurry' });
        continue;
      }
      if (!payload) {
        // A file we cannot read yet is not "missing": a human can look at it.
        const unreadable = doc.path !== null;
        fields.push({
          ...base,
          value: null,
          confidence: unreadable ? UNREADABLE_CONFIDENCE : 0,
          validationStatus: unreadable ? 'low_confidence' : 'missing',
          issue: unreadable ? 'unreadable' : 'missing',
        });
        continue;
      }

      const value = readValue(payload, spec);
      if (value === null) {
        // Not found in a file that exists: a human can still read it, so not "missing".
        fields.push(
          fromFile
            ? { ...base, value: null, confidence: UNREADABLE_CONFIDENCE, validationStatus: 'low_confidence', issue: 'unreadable' }
            : { ...base, value: null, confidence: 0, validationStatus: 'missing', issue: 'missing' },
        );
        continue;
      }
      if (spec.kind !== 'name' && !FORMAT_CHECKS[spec.kind](value)) {
        fields.push({
          ...base,
          value,
          confidence: Math.min(FORMAT_FAIL_CONFIDENCE, confidenceOf(spec.key)),
          validationStatus: 'low_confidence',
          issue: 'invalid_format',
        });
        continue;
      }
      const { issue, similarity } = compareWithForm(spec, value, form, docPan, nameThreshold);
      fields.push({
        ...base,
        value,
        confidence: confidenceOf(spec.key),
        validationStatus: issue ? 'mismatch' : 'ok',
        ...(issue ? { issue } : {}),
        ...(similarity !== undefined ? { similarity } : {}),
      });
    }
  }

  return {
    fields,
    blurryDocuments,
    missingDocuments: REQUIRED_DOCUMENTS.filter((t) => !byType.has(t)),
    missingFormFields: REQUIRED_FORM_FIELDS.filter((f) => !form[FORM_KEY[f]]),
  };
}
