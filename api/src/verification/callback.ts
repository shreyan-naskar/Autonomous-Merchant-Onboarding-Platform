import type { ProviderCallback } from '@app/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { callbackEvents } from '../db/schema.js';
import type { Logger } from '../logger.js';

export interface CallbackDeps {
  db: Db;
  logger: Logger;
  now: number;
}

export type ReceiveResult =
  | { duplicate: true; eventRowId: number }
  | { duplicate: false; eventRowId: number; outcome: string };

/**
 * Store a verified provider callback in callback_events, idempotently.
 *
 * In one IMMEDIATE transaction: if a non-duplicate row with this event_id
 * already exists, insert a second row flagged is_duplicate (for the audit
 * trail) and do nothing else. Otherwise insert the event and process it in
 * the same transaction, so "stored" and "applied" cannot disagree. If
 * processing throws, nothing is stored and the provider may redeliver.
 */
export function receiveCallback(deps: CallbackDeps, cb: ProviderCallback): ReceiveResult {
  const { db, logger, now } = deps;
  const result = db.transaction(
    (tx): ReceiveResult => {
      const existing = tx
        .select({ id: callbackEvents.id })
        .from(callbackEvents)
        .where(and(eq(callbackEvents.eventId, cb.event_id), eq(callbackEvents.isDuplicate, false)))
        .get();
      const row = tx
        .insert(callbackEvents)
        .values({
          eventId: cb.event_id,
          applicationId: cb.application_ref,
          kind: cb.kind,
          requestId: cb.request_id,
          payload: cb,
          receivedAt: now,
          isDuplicate: existing !== undefined,
          processed: false,
          note: existing ? 'duplicate ignored' : null,
        })
        .returning({ id: callbackEvents.id })
        .get();
      if (existing) return { duplicate: true, eventRowId: row.id };

      // Phase 4.5 applies the result to the matching verification here.
      return { duplicate: false, eventRowId: row.id, outcome: 'stored' };
    },
    { behavior: 'immediate' },
  );

  const log = { event_id: cb.event_id, request_id: cb.request_id, kind: cb.kind, application_id: cb.application_ref };
  if (result.duplicate) logger.info(log, 'duplicate ignored');
  else logger.info({ ...log, outcome: result.outcome }, 'provider callback received');
  return result;
}
