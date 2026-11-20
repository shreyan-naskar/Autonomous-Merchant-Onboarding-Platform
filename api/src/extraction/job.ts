import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { applications, documents, extractedFields, reviewTasks } from '../db/schema.js';
import { transition } from '../domain/transition.js';
import { enqueueJob } from '../jobs/queue.js';
import type { Logger } from '../logger.js';
import { decideAfterExtraction, type ExtractionDecision, type FieldProblem } from './decide.js';
import { extractFields } from './extract.js';

export interface ExtractionDeps {
  db: Db;
  logger: Logger;
  now: number;
  config: { thresholds: { confidence: number; nameMatch: number } };
}

const describeProblem = (p: FieldProblem) =>
  `${p.document}.${p.field} (${[
    p.issue,
    p.similarity !== undefined ? `similarity ${p.similarity}` : undefined,
    p.confidence !== undefined ? `confidence ${p.confidence}` : undefined,
  ]
    .filter(Boolean)
    .join(', ')})`;

/** Audit detail for the post-extraction transition. Field names and issues only, never values. */
function auditDetail(d: ExtractionDecision, threshold: number) {
  switch (d.reason) {
    case 'MISSING_INFO':
      return { reason: d.reason, missing: d.missing };
    case 'DOC_CONFLICT':
      return { reason: d.reason, conflicts: d.conflicts };
    case 'LOW_CONFIDENCE':
      return { reason: d.reason, threshold, low_confidence: d.lowConfidence };
    case 'EXTRACTION_OK':
      return { reason: d.reason };
  }
}

function reviewNote(d: ExtractionDecision): string {
  return d.reason === 'DOC_CONFLICT'
    ? `Document/form conflict: ${d.conflicts.map(describeProblem).join('; ')}`
    : `Low extraction confidence: ${d.lowConfidence.map(describeProblem).join('; ')}`;
}

/**
 * The `extract` job. SUBMITTED -> EXTRACTING, then in one transaction:
 * replace extracted_fields, transition to the decided state, open a review
 * task for IN_REVIEW, and enqueue `start_verifications` for VERIFYING.
 *
 * Idempotent: a retry finds the app in EXTRACTING and redoes the work; a
 * stale job (app already moved on) is a no-op.
 */
export function runExtraction(deps: ExtractionDeps, appId: string): ExtractionDecision | null {
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
  const result = extractFields(app, docs, { nameThreshold: config.thresholds.nameMatch });
  const decision = decideAfterExtraction(result, { confidenceThreshold: config.thresholds.confidence });

  db.transaction(
    (tx) => {
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
        detail: auditDetail(decision, config.thresholds.confidence),
        now,
      });

      if (decision.to === 'IN_REVIEW') {
        tx.insert(reviewTasks)
          .values({ applicationId: appId, reason: decision.reason, status: 'OPEN', note: reviewNote(decision), createdAt: now })
          .run();
      }
      if (decision.to === 'VERIFYING') {
        enqueueJob(tx, 'start_verifications', { application_id: appId }, { now });
      }
    },
    { behavior: 'immediate' },
  );

  logger.info(
    { application_id: appId, to: decision.to, reason: decision.reason, missing: decision.missing.length, conflicts: decision.conflicts.length },
    'extraction decided',
  );
  return decision;
}
