import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { applications, auditLog, type Application } from '../db/schema.js';

export interface NewApplicationInput {
  merchantName: string;
  pan?: string | null;
  gst?: string | null;
  bankAccount?: string | null;
  ifsc?: string | null;
}

/**
 * Insert a new application in SUBMITTED with its creation audit row.
 * This is the only place a status is set outside transition(): the initial one.
 */
export function createApplication(
  db: Db,
  input: NewApplicationInput,
  { now = Date.now(), id = randomUUID() }: { now?: number; id?: string } = {},
): Application {
  return db.transaction((tx) => {
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
        detail: null,
      })
      .run();
    return app;
  });
}
