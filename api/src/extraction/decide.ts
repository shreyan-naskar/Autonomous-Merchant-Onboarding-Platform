import type { ApplicationStatus, AuditEvent } from '@app/shared';
import type { BlurryDocument, ExtractionResult, FieldIssue, ProblemDocument } from './extract.js';

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
  event: AuditEvent;
  /** What the merchant must supply: `form.<field>`, `document.<TYPE>`, `<TYPE>.<payload key>`. */
  missing: string[];
  blurry: BlurryDocument[];
  /** Uploads that gave nothing usable as a whole (wrong document, blank, ...): explained to the reviewer first. */
  documentProblems: ProblemDocument[];
  conflicts: FieldProblem[];
  lowConfidence: FieldProblem[];
}

/**
 * Missing information goes back to the merchant; exceptions (blurry, conflict,
 * low confidence) go to a reviewer. Missing comes first because a review of an
 * incomplete application would just bounce back; blurry comes before conflicts
 * because nothing read from a blurry image can be trusted.
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
  const base = { missing, blurry, documentProblems: result.documentProblems, conflicts, lowConfidence };
  if (missing.length > 0) return { ...base, to: 'NEEDS_INFO', reason: 'MISSING_INFO', event: 'INFO_REQUIRED' };
  if (blurry.length > 0) return { ...base, to: 'IN_REVIEW', reason: 'BLURRY_DOCUMENT', event: 'BLURRY_DOCUMENT' };
  if (conflicts.length > 0) return { ...base, to: 'IN_REVIEW', reason: 'DOC_CONFLICT', event: 'DOC_CONFLICT' };
  if (lowConfidence.length > 0) return { ...base, to: 'IN_REVIEW', reason: 'LOW_CONFIDENCE', event: 'LOW_CONFIDENCE' };
  return { ...base, to: 'VERIFYING', reason: 'EXTRACTION_OK', event: 'VERIFICATION_STARTED' };
}
