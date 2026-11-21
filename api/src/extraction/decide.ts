import type { ApplicationStatus, AuditEvent } from '@app/shared';
import type { BlurryDocument, ExtractionResult, FieldIssue } from './extract.js';

export type ExtractionReason = 'MISSING_INFO' | 'BLURRY_DOCUMENT' | 'DOC_CONFLICT' | 'LOW_CONFIDENCE' | 'EXTRACTION_OK';

export interface FieldProblem {
  document: string;
  field: string;
  issue?: FieldIssue;
  confidence?: number;
  similarity?: number;
}

export interface ExtractionDecision {
  to: Extract<ApplicationStatus, 'NEEDS_INFO' | 'IN_REVIEW' | 'VERIFYING'>;
  reason: ExtractionReason;
  /** Audit event for the transition. */
  event: AuditEvent;
  /** What the merchant must supply: `form.<field>`, `document.<TYPE>`, `<TYPE>.<payload key>`. */
  missing: string[];
  blurry: BlurryDocument[];
  conflicts: FieldProblem[];
  lowConfidence: FieldProblem[];
}

/**
 * What to do after extraction. Pure. As in the brief: the system "requests
 * missing information or routes exceptions to a human reviewer". First
 * matching rule wins:
 *  1. anything missing           -> NEEDS_INFO (MISSING_INFO)
 *  2. any blurry uploaded image  -> IN_REVIEW  (BLURRY_DOCUMENT)
 *  3. any field mismatches       -> IN_REVIEW  (DOC_CONFLICT)
 *  4. any confidence < threshold -> IN_REVIEW  (LOW_CONFIDENCE)
 *  5. otherwise                  -> VERIFYING  (EXTRACTION_OK)
 * Missing comes first because asking the merchant is cheaper than a review,
 * and a review of an incomplete application would just bounce back. A blurry
 * image comes before conflicts because nothing read from it can be trusted.
 */
export function decideAfterExtraction(
  result: ExtractionResult,
  { confidenceThreshold }: { confidenceThreshold: number },
): ExtractionDecision {
  const missing = [
    ...result.missingFormFields.map((f) => `form.${f}`),
    ...result.missingDocuments.map((t) => `document.${t}`),
    ...result.fields.filter((f) => f.validationStatus === 'missing').map((f) => `${f.documentType}.${f.sourceKey}`),
  ];

  const conflicts: FieldProblem[] = result.fields
    .filter((f) => f.validationStatus === 'mismatch')
    .map((f) => ({
      document: f.documentType,
      field: f.field,
      issue: f.issue,
      ...(f.similarity !== undefined ? { similarity: f.similarity } : {}),
    }));

  const lowConfidence: FieldProblem[] = result.fields
    .filter((f) => f.validationStatus !== 'missing' && f.confidence < confidenceThreshold)
    .map((f) => ({ document: f.documentType, field: f.field, issue: f.issue, confidence: f.confidence }));

  const blurry = result.blurryDocuments;
  const base = { missing, blurry, conflicts, lowConfidence };
  if (missing.length > 0) return { ...base, to: 'NEEDS_INFO', reason: 'MISSING_INFO', event: 'INFO_REQUIRED' };
  if (blurry.length > 0) return { ...base, to: 'IN_REVIEW', reason: 'BLURRY_DOCUMENT', event: 'BLURRY_DOCUMENT' };
  if (conflicts.length > 0) return { ...base, to: 'IN_REVIEW', reason: 'DOC_CONFLICT', event: 'DOC_CONFLICT' };
  if (lowConfidence.length > 0) return { ...base, to: 'IN_REVIEW', reason: 'LOW_CONFIDENCE', event: 'LOW_CONFIDENCE' };
  return { ...base, to: 'VERIFYING', reason: 'EXTRACTION_OK', event: 'VERIFICATION_STARTED' };
}
