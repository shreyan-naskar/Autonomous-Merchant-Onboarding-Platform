import { REQUIRED_CHECKS, redactText, type VerificationKind } from '@app/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { applications, auditLog, verifications, type Application, type Verification } from '../db/schema.js';
import { enqueueJob } from '../jobs/queue.js';
import type { Logger } from '../logger.js';
import { buildProviderRequest, type ProviderClient } from '../providers/client.js';
import { applyEarlyCallbacks } from './callback.js';
import { currentVerification } from './latest.js';

export interface VerificationDeps {
  db: Db;
  logger: Logger;
  config: Config;
  /** Clock value (epoch ms) for this unit of work. */
  now: number;
}

export interface StartResult {
  /** Rows a provider accepted in this run. */
  requested: Verification[];
  /** Kinds skipped because a check is already in flight or complete. */
  skipped: VerificationKind[];
}

/**
 * Decide which kinds need a provider request and reserve a PENDING row for
 * each (one transaction). A kind needs a request when it has no current row
 * (first run, or the old one was superseded / is for an old bank_version) or
 * its current row TIMED_OUT (a retry: attempt + 1). A PENDING row without a
 * request_id is left over from a failed run and is reused, so retrying this
 * job never creates duplicate rows.
 */
function reserveRows(db: Db, appId: string, kinds: readonly VerificationKind[], now: number) {
  return db.transaction(
    (tx) => {
      const app = tx.select().from(applications).where(eq(applications.id, appId)).get();
      if (!app || app.status !== 'VERIFYING') return { app, rows: [] as Verification[], skipped: [...kinds] };

      const rows: Verification[] = [];
      const skipped: VerificationKind[] = [];
      for (const kind of kinds) {
        const current = currentVerification(tx, app, kind);
        if (!current || current.status === 'TIMED_OUT') {
          rows.push(
            tx
              .insert(verifications)
              .values({
                applicationId: appId,
                kind,
                status: 'PENDING',
                attempt: (current?.attempt ?? 0) + 1,
                bankVersion: app.bankVersion,
                requestedAt: now,
              })
              .returning()
              .get(),
          );
        } else if (current.status === 'PENDING' && current.requestId === null) {
          rows.push(current);
        } else {
          skipped.push(kind);
        }
      }
      return { app, rows, skipped };
    },
    { behavior: 'immediate' },
  );
}

/**
 * Record an accepted request: store the request_id, schedule the
 * verification_timeout job and audit VERIFICATION_REQUESTED, atomically,
 * then apply any callback for this request that arrived before the id was known.
 */
function recordRequested(deps: VerificationDeps, app: Application, row: Verification, requestId: string): Verification {
  const { db, config, now } = deps;
  return db.transaction(
    (tx) => {
      const updated = tx
        .update(verifications)
        .set({ requestId, requestedAt: now })
        .where(and(eq(verifications.id, row.id), isNull(verifications.requestId)))
        .returning()
        .get();
      if (!updated) throw new Error(`verification ${row.id} already has a request_id`);

      enqueueJob(
        tx,
        'verification_timeout',
        { application_id: app.id, verification_id: row.id },
        { now, runAt: now + config.timings.verificationTimeoutMs },
      );
      const status = tx.select({ status: applications.status }).from(applications).where(eq(applications.id, app.id)).get();
      tx.insert(auditLog)
        .values({
          applicationId: app.id,
          at: now,
          actor: 'system',
          fromState: status?.status ?? app.status,
          toState: null,
          event: 'VERIFICATION_REQUESTED',
          detail: { kind: row.kind, attempt: row.attempt, request_id: requestId, bank_version: row.bankVersion },
        })
        .run();
      // A fast provider may have called back before we stored the id.
      applyEarlyCallbacks(tx, requestId, now);
      return updated;
    },
    { behavior: 'immediate' },
  );
}

/**
 * The `start_verifications` job: request the given checks (default: all
 * required) for an application in VERIFYING. Provider calls happen outside
 * any DB transaction. If any call fails the job throws after the others are
 * recorded, so the worker retries only what is still missing.
 */
export async function runStartVerifications(
  deps: VerificationDeps,
  providers: ProviderClient,
  appId: string,
  kinds: readonly VerificationKind[] = REQUIRED_CHECKS,
): Promise<StartResult> {
  const { logger } = deps;
  const { app, rows, skipped } = reserveRows(deps.db, appId, kinds, deps.now);
  if (!app || app.status !== 'VERIFYING') {
    logger.info({ application_id: appId, status: app?.status }, 'start_verifications: application not in VERIFYING, skipping');
    return { requested: [], skipped };
  }

  const requested: Verification[] = [];
  const failures: string[] = [];
  for (const row of rows) {
    try {
      const { request_id } = await providers.request(row.kind, buildProviderRequest(row.kind, app));
      requested.push(recordRequested(deps, app, row, request_id));
      logger.info({ application_id: appId, kind: row.kind, attempt: row.attempt, request_id }, 'verification requested');
    } catch (err) {
      failures.push(redactText((err as Error).message));
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
  return { requested, skipped };
}
