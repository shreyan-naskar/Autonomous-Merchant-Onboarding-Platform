import { randomUUID } from 'node:crypto';
import type { ApplicationStatus, DocumentType } from '@app/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { applications, auditLog, documents, type Application } from '../db/schema.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { enqueueJob } from '../jobs/queue.js';
import type { Tx } from './guards.js';
import { transition } from './transition.js';

export interface NewApplicationInput {
  merchantName: string;
  pan?: string | null;
  gst?: string | null;
  bankAccount?: string | null;
  ifsc?: string | null;
}

export interface NewDocumentInput {
  type: DocumentType;
  /** Structured document body (JSON submissions). */
  payload?: Record<string, unknown> | null;
  /** Saved upload location (multipart submissions). */
  path?: string | null;
}

interface CreateOpts {
  now?: number;
  id?: string;
}

function insertApplication(tx: Tx, input: NewApplicationInput, now: number, id: string, detail: unknown): Application {
  const app = tx
    .insert(applications)
    .values({
      id,
      status: 'SUBMITTED',
      merchantName: input.merchantName,
      pan: input.pan ?? null,
      gst: input.gst ?? null,
      bankAccount: input.bankAccount ?? null,
      ifsc: input.ifsc ?? null,
      bankVersion: 1,
      createdAt: now,
      updatedAt: now,
      stateEnteredAt: now,
    })
    .returning()
    .get();
  tx.insert(auditLog)
    .values({
      applicationId: id,
      at: now,
      actor: 'merchant',
      fromState: null,
      toState: 'SUBMITTED',
      event: 'APPLICATION_SUBMITTED',
      detail: detail ?? null,
    })
    .run();
  return app;
}

/**
 * Insert a new application in SUBMITTED with its creation audit row.
 * This is the only place a status is set outside transition(): the initial one.
 */
export function createApplication(
  db: Db,
  input: NewApplicationInput,
  { now = Date.now(), id = randomUUID() }: CreateOpts = {},
): Application {
  return db.transaction((tx) => insertApplication(tx, input, now, id, null));
}

/**
 * Intake: application (SUBMITTED) + creation audit row + documents + an
 * `extract` job, all in one transaction. Either everything is persisted or
 * nothing is, so the worker never sees an application without its job.
 */
export function submitApplication(
  db: Db,
  input: NewApplicationInput,
  docs: NewDocumentInput[],
  { now = Date.now(), id = randomUUID(), via = 'json' }: CreateOpts & { via?: 'json' | 'multipart' } = {},
): Application {
  return db.transaction(
    (tx) => {
      const app = insertApplication(tx, input, now, id, { via, document_types: docs.map((d) => d.type) });
      for (const doc of docs) {
        tx.insert(documents)
          .values({
            applicationId: id,
            type: doc.type,
            payload: doc.payload ?? null,
            path: doc.path ?? null,
            createdAt: now,
          })
          .run();
      }
      enqueueJob(tx, 'extract', { application_id: id }, { now });
      return app;
    },
    { behavior: 'immediate' },
  );
}

const WIRE_NAMES: Record<string, string> = { merchantName: 'merchant_name', bankAccount: 'bank_account' };

/** States in which the merchant can no longer edit the application. */
const LOCKED_STATES: readonly ApplicationStatus[] = ['APPROVED', 'MERCHANT_CREATED', 'MERCHANT_CREATION_FAILED', 'REJECTED'];

export interface ApplicationPatch extends Partial<NewApplicationInput> {
  /** Structured documents; each replaces the existing document of its type. NEEDS_INFO only. */
  documents?: NewDocumentInput[];
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Merchant edits: form fields, plus documents while in NEEDS_INFO.
 *
 * - In NEEDS_INFO, any real change is the merchant supplying the requested
 *   info: NEEDS_INFO -> EXTRACTING (actor merchant, event INFO_SUPPLIED) and
 *   a new `extract` job, in the same transaction as the edit.
 * - Elsewhere, persists the fields and writes APPLICATION_UPDATED; status is
 *   untouched (bank-change re-verification is Phase 5).
 * Audit details name the changed fields / document types, never values.
 */
export function updateApplication(
  db: Db,
  id: string,
  patch: ApplicationPatch,
  { now = Date.now() }: { now?: number } = {},
): Application {
  return db.transaction(
    (tx) => {
      const app = tx.select().from(applications).where(eq(applications.id, id)).get();
      if (!app) throw new NotFoundError(`Application ${id} not found`);
      if (LOCKED_STATES.includes(app.status)) {
        throw new ConflictError(`Application cannot be edited in ${app.status}`, { status: app.status });
      }
      const docs = patch.documents ?? [];
      if (docs.length > 0 && app.status !== 'NEEDS_INFO') {
        throw new ConflictError('Documents can only be added while the application needs info', { status: app.status });
      }

      const changes: Partial<Record<'merchantName' | 'pan' | 'gst' | 'bankAccount' | 'ifsc', string>> = {};
      for (const key of ['merchantName', 'pan', 'gst', 'bankAccount', 'ifsc'] as const) {
        const value = patch[key];
        if (value !== undefined && value !== null && value !== app[key]) changes[key] = value;
      }
      const changed = Object.keys(changes).map((k) => WIRE_NAMES[k] ?? k);

      const changedDocs: DocumentType[] = [];
      for (const doc of docs) {
        const existing = tx
          .select()
          .from(documents)
          .where(and(eq(documents.applicationId, id), eq(documents.type, doc.type)))
          .get();
        if (existing && sameJson(existing.payload, doc.payload) && (existing.path ?? null) === (doc.path ?? null)) continue;
        if (existing) {
          tx.update(documents)
            .set({ payload: doc.payload ?? null, path: doc.path ?? null, blurScore: null, createdAt: now })
            .where(eq(documents.id, existing.id))
            .run();
        } else {
          tx.insert(documents)
            .values({ applicationId: id, type: doc.type, payload: doc.payload ?? null, path: doc.path ?? null, createdAt: now })
            .run();
        }
        changedDocs.push(doc.type);
      }

      if (changed.length === 0 && changedDocs.length === 0) return app;

      let updated = tx
        .update(applications)
        .set({ ...changes, updatedAt: now })
        .where(eq(applications.id, id))
        .returning()
        .get();

      if (app.status === 'NEEDS_INFO') {
        updated = transition(tx, id, 'EXTRACTING', {
          actor: 'merchant',
          event: 'INFO_SUPPLIED',
          detail: { fields: changed, documents: changedDocs },
          now,
        });
        enqueueJob(tx, 'extract', { application_id: id }, { now });
        return updated;
      }

      tx.insert(auditLog)
        .values({
          applicationId: id,
          at: now,
          actor: 'merchant',
          fromState: app.status,
          toState: null,
          event: 'APPLICATION_UPDATED',
          detail: { fields: changed },
        })
        .run();
      return updated;
    },
    { behavior: 'immediate' },
  );
}
