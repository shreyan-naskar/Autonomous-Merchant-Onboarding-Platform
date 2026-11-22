import { DOCUMENT_LABELS, type DocumentType, type InfoRequestDetail } from '@app/shared';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { applications, documents, extractedFields, reviewTasks } from '../db/schema.js';
import { transition } from '../domain/transition.js';
import { enqueueJob } from '../jobs/queue.js';
import type { Logger } from '../logger.js';
import { decideAfterExtraction, type ExtractionDecision, type FieldProblem } from './decide.js';
import { extractFields, type ProblemDocument } from './extract.js';
import type { OcrEngine } from './ocr.js';
import { readUploadedDocuments } from './read.js';
import { merchantRequests } from './requests.js';

interface ExtractionDeps {
  db: Db;
  logger: Logger;
  now: number;
  config: { thresholds: { confidence: number; nameMatch: number; blur: number } };
}

const describeProblem = (p: FieldProblem) =>
  `${p.document}.${p.field} (${[
    p.issue,
    p.similarity !== undefined ? `similarity ${p.similarity}` : undefined,
    p.confidence !== undefined ? `confidence ${p.confidence}` : undefined,
  ]
    .filter(Boolean)
    .join(', ')})`;

/** "PAN card" stays as is mid-sentence; "Bank proof" becomes "bank proof". */
const inSentence = (t: DocumentType) => {
  const l = DOCUMENT_LABELS[t];
  return /^[A-Z]{2}/.test(l) ? l : l[0]!.toLowerCase() + l.slice(1);
};

/** One plain sentence per upload that gave nothing usable, so the reviewer knows what to ask the merchant for. */
export function describeDocument(p: ProblemDocument): string {
  const what = DOCUMENT_LABELS[p.documentType];
  switch (p.problem) {
    case 'wrong_document':
      return `${what}: this looks like a ${inSentence(p.looksLike!)}, not a ${inSentence(p.documentType)}.`;
    case 'blank':
      return `${what}: the upload is blank.`;
    case 'password_protected':
      return `${what}: the PDF is password-protected, so it could not be read.`;
    case 'no_text':
      return `${what}: no text found; the image does not look like a document.`;
    case 'damaged':
      return `${what}: the file is damaged or is not the kind of file its name says.`;
  }
}

const documentDetail = (d: ExtractionDecision) =>
  d.documentProblems.length > 0
    ? {
        documents: d.documentProblems.map((p) => ({
          document: p.documentType,
          document_id: p.documentId,
          problem: p.problem,
          ...(p.looksLike ? { looks_like: p.looksLike } : {}),
        })),
      }
    : {};

/** Field names and issues only, never values. */
function auditDetail(d: ExtractionDecision, threshold: number, blurThreshold: number) {
  switch (d.reason) {
    case 'MISSING_INFO': {
      const r = merchantRequests(d.missing);
      const detail: InfoRequestDetail = {
        reason: d.reason,
        missing: d.missing,
        requests: r.requests,
        form_fields: r.formFields,
        documents: r.documents,
      };
      return detail;
    }
    case 'BLURRY_DOCUMENT':
      return {
        reason: d.reason,
        blur_threshold: blurThreshold,
        blurry: d.blurry.map((b) => ({ document: b.documentType, document_id: b.documentId, blur_score: b.blurScore })),
      };
    case 'DOC_CONFLICT':
      return { reason: d.reason, ...documentDetail(d), conflicts: d.conflicts };
    case 'LOW_CONFIDENCE':
      return { reason: d.reason, ...documentDetail(d), threshold, low_confidence: d.lowConfidence };
    case 'EXTRACTION_OK':
      return { reason: d.reason };
  }
}

function reviewNote(d: ExtractionDecision, blurThreshold: number): string {
  const documents = d.documentProblems.map(describeDocument).join(' ');
  const fields = fieldNote(d, blurThreshold);
  return documents && d.reason !== 'BLURRY_DOCUMENT' ? `${documents} ${fields}` : fields;
}

function fieldNote(d: ExtractionDecision, blurThreshold: number): string {
  switch (d.reason) {
    case 'BLURRY_DOCUMENT':
      return `Blurry document image, re-upload or read manually: ${d.blurry
        .map((b) => `${b.documentType} (blur score ${b.blurScore} < threshold ${blurThreshold})`)
        .join('; ')}`;
    case 'DOC_CONFLICT':
      return `Document/form conflict: ${d.conflicts.map(describeProblem).join('; ')}`;
    default:
      return `Low extraction confidence: ${d.lowConfidence.map(describeProblem).join('; ')}`;
  }
}

/** Idempotent: a retry finds the application in EXTRACTING and redoes the work; a stale job is a no-op. */
export async function runExtraction(
  deps: ExtractionDeps,
  ocr: OcrEngine,
  appId: string,
): Promise<ExtractionDecision | null> {
  const { db, logger, now, config } = deps;
  let app = db.select().from(applications).where(eq(applications.id, appId)).get();
  if (!app) {
    logger.warn({ application_id: appId }, 'extract: application not found, skipping');
    return null;
  }
  if (app.status === 'SUBMITTED') {
    app = transition(db, appId, 'EXTRACTING', { actor: 'system', event: 'EXTRACTION_STARTED', now });
  } else if (app.status !== 'EXTRACTING') {
    logger.info({ application_id: appId, status: app.status }, 'extract: application not awaiting extraction, skipping');
    return null;
  }

  const docs = db.select().from(documents).where(eq(documents.applicationId, appId)).orderBy(asc(documents.id)).all();
  const readings = await readUploadedDocuments(docs, { ocr, blurThreshold: config.thresholds.blur });
  const result = extractFields(
    app,
    docs.map((d) => ({ ...d, reading: readings.get(d.id) })),
    { nameThreshold: config.thresholds.nameMatch },
  );
  const decision = decideAfterExtraction(result, { confidenceThreshold: config.thresholds.confidence });

  db.transaction(
    (tx) => {
      for (const [docId, r] of readings) {
        if (r.blurScore !== undefined) {
          tx.update(documents).set({ blurScore: r.blurScore }).where(eq(documents.id, docId)).run();
        }
      }
      // Each extraction is a fresh snapshot of the current documents.
      tx.delete(extractedFields).where(eq(extractedFields.applicationId, appId)).run();
      if (result.fields.length > 0) {
        tx.insert(extractedFields)
          .values(
            result.fields.map((f) => ({
              applicationId: appId,
              documentId: f.documentId,
              field: f.field,
              value: f.value,
              confidence: f.confidence,
              validationStatus: f.validationStatus,
            })),
          )
          .run();
      }

      transition(tx, appId, decision.to, {
        actor: 'system',
        event: decision.event,
        detail: auditDetail(decision, config.thresholds.confidence, config.thresholds.blur),
        now,
      });

      if (decision.to === 'IN_REVIEW') {
        tx.insert(reviewTasks)
          .values({
            applicationId: appId,
            reason: decision.reason,
            status: 'OPEN',
            note: reviewNote(decision, config.thresholds.blur),
            createdAt: now,
          })
          .run();
      }
      if (decision.to === 'VERIFYING') {
        enqueueJob(tx, 'start_verifications', { application_id: appId }, { now });
      }
    },
    { behavior: 'immediate' },
  );

  logger.info(
    {
      application_id: appId,
      to: decision.to,
      reason: decision.reason,
      missing: decision.missing.length,
      conflicts: decision.conflicts.length,
    },
    'extraction decided',
  );
  return decision;
}
