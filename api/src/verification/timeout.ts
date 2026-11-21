import { eq } from 'drizzle-orm';
import { applications, auditLog, reviewTasks, verifications } from '../db/schema.js';
import { transition } from '../domain/transition.js';
import { enqueueJob } from '../jobs/queue.js';
import { backoffDelayMs } from '../jobs/worker.js';
import type { VerificationDeps } from './start.js';

export type TimeoutOutcome =
  | 'not_pending'
  | 'retry_scheduled'
  | 'escalated'
  | 'timed_out';

/** Retries with backoff, then escalates to review. A late callback can still complete the TIMED_OUT row afterwards. */
export function runVerificationTimeout(deps: VerificationDeps, verificationId: number): TimeoutOutcome {
  const { db, config, logger, now } = deps;
  const outcome = db.transaction(
    (tx): { outcome: TimeoutOutcome; kind?: string; attempt?: number } => {
      const row = tx.select().from(verifications).where(eq(verifications.id, verificationId)).get();
      if (!row || row.status !== 'PENDING' || row.superseded) return { outcome: 'not_pending' };
      const app = tx.select().from(applications).where(eq(applications.id, row.applicationId)).get()!;
      if (row.kind === 'BANK' && row.bankVersion !== app.bankVersion) return { outcome: 'not_pending' };

      tx.update(verifications).set({ status: 'TIMED_OUT' }).where(eq(verifications.id, row.id)).run();

      const base = { kind: row.kind, attempt: row.attempt, request_id: row.requestId, timeout_ms: config.timings.verificationTimeoutMs };
      const retriesLeft = row.attempt <= config.limits.verificationMaxRetries;

      if (app.status === 'VERIFYING' && !retriesLeft) {
        const reason = `${row.kind}_TIMEOUT`;
        transition(tx, app.id, 'IN_REVIEW', {
          actor: 'system',
          event: 'VERIFICATION_TIMED_OUT',
          detail: { ...base, reason, attempts: row.attempt },
          now,
        });
        tx.insert(reviewTasks)
          .values({
            applicationId: app.id,
            reason,
            status: 'OPEN',
            note: `${row.kind} provider did not respond after ${row.attempt} attempt(s) of ${config.timings.verificationTimeoutMs / 1000}s each`,
            createdAt: now,
          })
          .run();
        return { outcome: 'escalated', kind: row.kind, attempt: row.attempt };
      }

      const retry = app.status === 'VERIFYING' && retriesLeft;
      const retryAt = now + backoffDelayMs(config.timings.backoffBaseMs, row.attempt);
      if (retry) enqueueJob(tx, 'start_verifications', { application_id: app.id, kinds: [row.kind] }, { now, runAt: retryAt });
      tx.insert(auditLog)
        .values({
          applicationId: app.id,
          at: now,
          actor: 'system',
          fromState: app.status,
          toState: null,
          event: 'VERIFICATION_TIMED_OUT',
          detail: retry ? { ...base, retry_attempt: row.attempt + 1, retry_at: new Date(retryAt).toISOString() } : base,
        })
        .run();
      return { outcome: retry ? 'retry_scheduled' : 'timed_out', kind: row.kind, attempt: row.attempt };
    },
    { behavior: 'immediate' },
  );

  if (outcome.outcome !== 'not_pending') {
    logger.warn({ verification_id: verificationId, kind: outcome.kind, attempt: outcome.attempt, outcome: outcome.outcome }, 'verification timed out');
  }
  return outcome.outcome;
}
