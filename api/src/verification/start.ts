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
  now: number;
}

interface StartResult {
  requested: Verification[];
  skipped: VerificationKind[];
}

/** A bank-change re-run may also run in IN_REVIEW, and is skipped once a newer bank change bumped the version. */
function canRequest(app: Application, bankVersion?: number): boolean {
  if (bankVersion === undefined) return app.status === 'VERIFYING';
  return bankVersion === app.bankVersion && (app.status === 'VERIFYING' || app.status === 'IN_REVIEW');
}

/** A PENDING row without a request_id is left over from a failed run and is reused, so retries never duplicate rows. */
function reserveRows(db: Db, appId: string, kinds: readonly VerificationKind[], now: number, bankVersion?: number) {
  return db.transaction(
    (tx) => {
      const app = tx.select().from(applications).where(eq(applications.id, appId)).get();
      if (!app || !canRequest(app, bankVersion)) return { app, rows: [] as Verification[], skipped: [...kinds] };

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
      applyEarlyCallbacks(tx, requestId, now);
      return updated;
    },
    { behavior: 'immediate' },
  );
}

/** Provider calls happen outside any DB transaction. If one fails the job throws after recording the others, so a retry only requests what is missing. */
export async function runStartVerifications(
  deps: VerificationDeps,
  providers: ProviderClient,
  appId: string,
  kinds: readonly VerificationKind[] = REQUIRED_CHECKS,
  bankVersion?: number,
): Promise<StartResult> {
  const { logger } = deps;
  const { app, rows, skipped } = reserveRows(deps.db, appId, kinds, deps.now, bankVersion);
  if (!app || !canRequest(app, bankVersion)) {
    logger.info({ application_id: appId, status: app?.status, bank_version: bankVersion }, 'start_verifications: not applicable, skipping');
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
