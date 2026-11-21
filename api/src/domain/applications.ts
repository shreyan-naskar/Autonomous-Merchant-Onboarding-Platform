import { randomUUID } from 'node:crypto';
import type { ApplicationStatus, DocumentType } from '@app/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { applications, auditLog, documents, reviewTasks, verifications, type Application } from '../db/schema.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { enqueueJob } from '../jobs/queue.js';
import { flagDuplicates } from './duplicates.js';
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
  payload?: Record<string, unknown> | null;
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

/** The only status write outside transition(): the initial SUBMITTED. */
export function createApplication(
  db: Db,
  input: NewApplicationInput,
  { now = Date.now(), id = randomUUID() }: CreateOpts = {},
): Application {
  return db.transaction((tx) => insertApplication(tx, input, now, id, null));
}

/** Application, documents and the extract job commit together, so the worker never sees an application without its job. */
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
      flagDuplicates(tx, app, now);
      enqueueJob(tx, 'extract', { application_id: id }, { now });
      return app;
    },
    { behavior: 'immediate' },
  );
}

const WIRE_NAMES: Record<string, string> = { merchantName: 'merchant_name', bankAccount: 'bank_account' };

const LOCKED_STATES: readonly ApplicationStatus[] = ['APPROVED', 'MERCHANT_CREATED', 'MERCHANT_CREATION_FAILED', 'REJECTED'];

interface ApplicationPatch extends Partial<NewApplicationInput> {
  /** Replaces the document of the same type. Only accepted in NEEDS_INFO. */
  documents?: NewDocumentInput[];
}

const BANK_REVERIFY_STATES: readonly ApplicationStatus[] = ['VERIFYING', 'VERIFIED', 'IN_REVIEW'];

/**
 * Bank details changed after verification started. Bumping bank_version and
 * superseding the old BANK rows makes the approval guard wait for a fresh BANK
 * pass and turns callbacks for the old account into STALE ones. Only BANK is
 * re-run; from VERIFIED the application goes back through IN_REVIEW to
 * VERIFYING, and evaluate() auto-resolves the BANK_CHANGED task once it passes.
 */
function applyBankChange(tx: Tx, app: Application, changed: string[], now: number): Application {
  const from = app.bankVersion;
  const to = from + 1;
  tx.update(applications).set({ bankVersion: to }).where(eq(applications.id, app.id)).run();
  tx.update(verifications)
    .set({ superseded: true })
    .where(and(eq(verifications.applicationId, app.id), eq(verifications.kind, 'BANK'), eq(verifications.superseded, false)))
    .run();
  const detail = { fields: changed, bank_version_from: from, bank_version_to: to };

  let updated: Application;
  if (app.status === 'VERIFIED') {
    transition(tx, app.id, 'IN_REVIEW', { actor: 'merchant', event: 'BANK_CHANGED', detail, now });
    tx.insert(reviewTasks)
      .values({
        applicationId: app.id,
        reason: 'BANK_CHANGED',
        status: 'OPEN',
        note: `Bank details changed after verification (bank version ${from} -> ${to}); BANK is being re-verified. Approval is blocked until it passes.`,
        createdAt: now,
      })
      .run();
    updated = transition(tx, app.id, 'VERIFYING', {
      actor: 'system',
      event: 'BANK_REVERIFICATION_STARTED',
      detail: { kinds: ['BANK'], bank_version: to },
      now,
    });
  } else {
    tx.insert(auditLog)
      .values({ applicationId: app.id, at: now, actor: 'merchant', fromState: app.status, toState: null, event: 'BANK_CHANGED', detail })
      .run();
    updated = tx.select().from(applications).where(eq(applications.id, app.id)).get()!;
  }
  enqueueJob(tx, 'start_verifications', { application_id: app.id, kinds: ['BANK'], bank_version: to }, { now });
  return updated;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Merchant edits. In NEEDS_INFO any real change restarts extraction in the
 * same transaction; a bank change after verification goes through
 * applyBankChange; otherwise the fields are saved and audited. Audit details
 * name the changed fields, never their values.
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

      if ((changes.bankAccount !== undefined || changes.ifsc !== undefined) && BANK_REVERIFY_STATES.includes(app.status)) {
        return applyBankChange(tx, updated, changed, now);
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
