import { ProviderCallbackSchema, type AuditEvent, type ProviderCallback } from '@app/shared';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { applications, auditLog, callbackEvents, verifications } from '../db/schema.js';
import type { Tx } from '../domain/guards.js';
import type { Logger } from '../logger.js';
import { evaluate } from './evaluate.js';

export interface CallbackDeps {
  db: Db;
  logger: Logger;
  now: number;
}

/**
 * What a callback did:
 * - applied: result recorded on a PENDING check, application re-evaluated
 * - late: result recorded on a TIMED_OUT check (audited LATE_CALLBACK), re-evaluated
 * - stale: recorded for the record, but the check is superseded or for an old
 *   bank_version, so it does not count (audited STALE_CALLBACK)
 * - already_completed: the check already has a result; ignored
 * - mismatch: request_id belongs to another application or kind; ignored
 * - unknown_request: no check has this request_id (yet); kept unprocessed and
 *   applied if start_verifications stores that request_id later
 */
export type CallbackOutcome = 'applied' | 'late' | 'stale' | 'already_completed' | 'mismatch' | 'unknown_request';

export type ReceiveResult =
  | { duplicate: true; eventRowId: number }
  | { duplicate: false; eventRowId: number; outcome: CallbackOutcome };

/**
 * Apply one callback to its verification row (inside the caller's
 * transaction). Never throws for an unexpected callback: anything that
 * cannot be applied is reported as an outcome and left in callback_events.
 */
export function applyCallback(tx: Tx, cb: ProviderCallback, now: number): CallbackOutcome {
  const row = tx.select().from(verifications).where(eq(verifications.requestId, cb.request_id)).get();
  if (!row) return 'unknown_request';
  if (row.applicationId !== cb.application_ref || row.kind !== cb.kind) return 'mismatch';
  if (row.status === 'PASSED' || row.status === 'FAILED') return 'already_completed';

  const app = tx.select().from(applications).where(eq(applications.id, row.applicationId)).get()!;
  const oldBank =
    row.kind === 'BANK' &&
    (row.bankVersion !== app.bankVersion || (cb.bank_version !== undefined && cb.bank_version !== row.bankVersion));
  const stale = row.superseded || oldBank;
  const late = row.status === 'TIMED_OUT';

  tx.update(verifications)
    .set({
      status: cb.result.status,
      completedAt: now,
      score: cb.result.score ?? null,
      rawResponse: { event_id: cb.event_id, result: cb.result, ...(late ? { late: true } : {}) },
    })
    .where(eq(verifications.id, row.id))
    .run();

  // A real result outranks newer attempts of the same check that have none
  // (a retry still PENDING, or one that also timed out): supersede them so
  // this row becomes the current one and their callbacks no longer count.
  const replaced = stale
    ? []
    : tx
        .update(verifications)
        .set({ superseded: true })
        .where(
          and(
            eq(verifications.applicationId, row.applicationId),
            eq(verifications.kind, row.kind),
            eq(verifications.superseded, false),
            gt(verifications.id, row.id),
            inArray(verifications.status, ['PENDING', 'TIMED_OUT']),
          ),
        )
        .returning({ requestId: verifications.requestId, attempt: verifications.attempt })
        .all();

  const event: AuditEvent = stale ? 'STALE_CALLBACK' : late ? 'LATE_CALLBACK' : 'VERIFICATION_RESULT';
  tx.insert(auditLog)
    .values({
      applicationId: row.applicationId,
      at: now,
      actor: 'provider',
      fromState: app.status,
      toState: null,
      event,
      detail: {
        kind: row.kind,
        request_id: cb.request_id,
        event_id: cb.event_id,
        attempt: row.attempt,
        status: cb.result.status,
        ...(cb.result.reason ? { reason: cb.result.reason } : {}),
        ...(cb.result.score !== undefined ? { score: cb.result.score } : {}),
        ...(late ? { timed_out_at_attempt: row.attempt } : {}),
        ...(stale ? { ignored: row.superseded ? 'superseded' : 'old_bank_version', bank_version: row.bankVersion, current_bank_version: app.bankVersion } : {}),
        ...(replaced.length > 0 ? { superseded_attempts: replaced.map((r) => r.attempt) } : {}),
      },
    })
    .run();

  if (!stale) evaluate(tx, row.applicationId, now);
  return stale ? 'stale' : late ? 'late' : 'applied';
}

/** Outcomes after which the event needs no further work. */
const isFinal = (o: CallbackOutcome) => o !== 'unknown_request';

/**
 * Store a verified provider callback in callback_events, idempotently.
 *
 * In one IMMEDIATE transaction: if a non-duplicate row with this event_id
 * already exists, insert a second row flagged is_duplicate (for the audit
 * trail) and do nothing else. Otherwise insert the event and apply it in
 * the same transaction, so "stored" and "applied" cannot disagree. If
 * applying throws, nothing is stored and the provider may redeliver.
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
      if (existing) {
        const dup = tx
          .insert(callbackEvents)
          .values({
            eventId: cb.event_id,
            applicationId: cb.application_ref,
            kind: cb.kind,
            requestId: cb.request_id,
            payload: cb,
            receivedAt: now,
            isDuplicate: true,
            processed: false,
            note: 'duplicate ignored',
          })
          .returning({ id: callbackEvents.id })
          .get();
        return { duplicate: true, eventRowId: dup.id };
      }

      const outcome = applyCallback(tx, cb, now);
      const row = tx
        .insert(callbackEvents)
        .values({
          eventId: cb.event_id,
          applicationId: cb.application_ref,
          kind: cb.kind,
          requestId: cb.request_id,
          payload: cb,
          receivedAt: now,
          isDuplicate: false,
          processed: isFinal(outcome),
          note: outcome,
        })
        .returning({ id: callbackEvents.id })
        .get();
      return { duplicate: false, eventRowId: row.id, outcome };
    },
    { behavior: 'immediate' },
  );

  const log = { event_id: cb.event_id, request_id: cb.request_id, kind: cb.kind, application_id: cb.application_ref };
  if (result.duplicate) logger.info(log, 'duplicate ignored');
  else if (result.outcome === 'applied' || result.outcome === 'late') logger.info({ ...log, outcome: result.outcome }, 'provider callback applied');
  else logger.warn({ ...log, outcome: result.outcome }, 'provider callback not applied');
  return result;
}

/**
 * Apply callbacks that arrived before their request_id was stored (a fast
 * provider can call back before start_verifications records the id). Called
 * in the same transaction that stores the request_id.
 */
export function applyEarlyCallbacks(tx: Tx, requestId: string, now: number): CallbackOutcome[] {
  const waiting = tx
    .select()
    .from(callbackEvents)
    .where(
      and(eq(callbackEvents.requestId, requestId), eq(callbackEvents.isDuplicate, false), eq(callbackEvents.processed, false)),
    )
    .orderBy(callbackEvents.id)
    .all();
  return waiting.map((ev) => {
    const parsed = ProviderCallbackSchema.safeParse(ev.payload);
    const outcome: CallbackOutcome = parsed.success ? applyCallback(tx, parsed.data, now) : 'mismatch';
    tx.update(callbackEvents)
      .set({ processed: isFinal(outcome), note: `${outcome} (after request_id stored)` })
      .where(eq(callbackEvents.id, ev.id))
      .run();
    return outcome;
  });
}
