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

/*
 * Extraction for structured (JSON) documents. Pure: takes the application's
 * form values and its documents, returns one row per expected document field
 * plus what is missing. No DB, no clock.
 */

/** Every application needs one of each. */
export const REQUIRED_DOCUMENTS: readonly DocumentType[] = DOCUMENT_TYPES;

/** Form fields (wire names) required before verification can start. */
export const REQUIRED_FORM_FIELDS = ['pan', 'gst', 'bank_account', 'ifsc'] as const;
export type FormField = (typeof REQUIRED_FORM_FIELDS)[number];

/** Confidence for a value read from structured JSON. */
export const STRUCTURED_CONFIDENCE = 1.0;
/** Confidence for a value that is present but fails its format rule (below the 0.8 default threshold). */
export const FORMAT_FAIL_CONFIDENCE = 0.5;
/** An uploaded file with no structured payload: nothing could be read yet (OCR is Phase 7). */
export const UNREADABLE_CONFIDENCE = 0;

type ValueKind = 'pan' | 'gstin' | 'bank_account' | 'ifsc' | 'name';

interface FieldSpec {
  /** Key in the document payload. */
  key: string;
  /** Stored extracted_fields.field. pan / gst / bank_account are masked by name in responses. */
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
  | 'invalid_format'
  | 'differs_from_form'
  | 'gstin_pan_mismatch'
  | 'name_mismatch';

export interface ExtractedFieldResult {
  documentType: DocumentType;
  documentId: number;
  /** Payload key the value came from (for messages like "GST_CERT.gstin"). */
  sourceKey: string;
  field: string;
  value: string | null;
  confidence: number;
  validationStatus: ValidationStatus;
  issue?: FieldIssue;
  /** Name similarity to the form's merchant name (name fields only). */
  similarity?: number;
}

export interface ExtractionResult {
  fields: ExtractedFieldResult[];
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
}

const FORM_KEY: Record<FormField, keyof ExtractionForm> = {
  pan: 'pan',
  gst: 'gst',
  bank_account: 'bankAccount',
  ifsc: 'ifsc',
};

/** Normalize a document value: trim; codes are case-insensitive so uppercase them. */
function readValue(payload: Record<string, unknown>, spec: FieldSpec): string | null {
  const raw = payload[spec.key];
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  return spec.kind === 'name' ? s : s.toUpperCase();
}

/** Compare a well-formed document value with the form. Returns the first conflict, if any. */
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
 * Map documents to extracted fields. Per field, first matching rule wins:
 *  - absent value                  -> `missing`, confidence 0
 *  - uploaded file without payload -> `low_confidence`, confidence 0 (`unreadable`)
 *  - fails its format rule         -> `low_confidence`, confidence 0.5
 *  - disagrees with the form       -> `mismatch`, confidence 1.0
 *  - otherwise                     -> `ok`, confidence 1.0
 * Unknown document types are ignored; extra payload keys (e.g. dob) are not extracted.
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

  const panCard = byType.get('PAN_CARD');
  const panPayload = panCard?.payload as Record<string, unknown> | null | undefined;
  const docPan = panPayload ? readValue(panPayload, DOCUMENT_FIELDS.PAN_CARD[0]!) : null;

  const fields: ExtractedFieldResult[] = [];
  for (const type of DOCUMENT_TYPES) {
    const doc = byType.get(type);
    if (!doc) continue;
    const payload = doc.payload && typeof doc.payload === 'object' ? (doc.payload as Record<string, unknown>) : null;

    for (const spec of DOCUMENT_FIELDS[type]) {
      const base = { documentType: type, documentId: doc.id, sourceKey: spec.key, field: spec.field };

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
        fields.push({ ...base, value: null, confidence: 0, validationStatus: 'missing', issue: 'missing' });
        continue;
      }
      if (spec.kind !== 'name' && !FORMAT_CHECKS[spec.kind](value)) {
        fields.push({
          ...base,
          value,
          confidence: FORMAT_FAIL_CONFIDENCE,
          validationStatus: 'low_confidence',
          issue: 'invalid_format',
        });
        continue;
      }
      const { issue, similarity } = compareWithForm(spec, value, form, docPan, nameThreshold);
      fields.push({
        ...base,
        value,
        confidence: STRUCTURED_CONFIDENCE,
        validationStatus: issue ? 'mismatch' : 'ok',
        ...(issue ? { issue } : {}),
        ...(similarity !== undefined ? { similarity } : {}),
      });
    }
  }

  return {
    fields,
    missingDocuments: REQUIRED_DOCUMENTS.filter((t) => !byType.has(t)),
    missingFormFields: REQUIRED_FORM_FIELDS.filter((f) => !form[FORM_KEY[f]]),
  };
}
