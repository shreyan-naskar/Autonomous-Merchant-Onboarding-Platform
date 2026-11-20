import { randomUUID } from 'node:crypto';
import type { ApplicationStatus, DocumentType } from '@app/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { applications, auditLog, documents, type Application } from '../db/schema.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { enqueueJob } from '../jobs/queue.js';
import type { Tx } from './guards.js';

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

/**
 * Merchant edits to form fields. Persists the changed fields and writes an
 * APPLICATION_UPDATED audit row naming the fields (never their values).
 * Status is untouched: bank-change re-verification is Phase 5.
 */
export function updateApplication(
  db: Db,
  id: string,
  patch: NewApplicationInput | Partial<NewApplicationInput>,
  { now = Date.now() }: { now?: number } = {},
): Application {
  return db.transaction(
    (tx) => {
      const app = tx.select().from(applications).where(eq(applications.id, id)).get();
      if (!app) throw new NotFoundError(`Application ${id} not found`);
      if (LOCKED_STATES.includes(app.status)) {
        throw new ConflictError(`Application cannot be edited in ${app.status}`, { status: app.status });
      }

      const changes: Partial<Record<'merchantName' | 'pan' | 'gst' | 'bankAccount' | 'ifsc', string>> = {};
      for (const key of ['merchantName', 'pan', 'gst', 'bankAccount', 'ifsc'] as const) {
        const value = patch[key];
        if (value !== undefined && value !== null && value !== app[key]) changes[key] = value;
      }
      const changed = Object.keys(changes).map((k) => WIRE_NAMES[k] ?? k);
      if (changed.length === 0) return app;

      const updated = tx
        .update(applications)
        .set({ ...changes, updatedAt: now })
        .where(eq(applications.id, id))
        .returning()
        .get();
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
