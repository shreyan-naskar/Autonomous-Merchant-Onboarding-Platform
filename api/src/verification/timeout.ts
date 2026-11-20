import { eq } from 'drizzle-orm';
import { applications, auditLog, reviewTasks, verifications } from '../db/schema.js';
import { transition } from '../domain/transition.js';
import { enqueueJob } from '../jobs/queue.js';
import { backoffDelayMs } from '../jobs/worker.js';
import type { VerificationDeps } from './start.js';

export type TimeoutOutcome =
  /** The check already has a result, was superseded, or is for an old bank_version. */
  | 'not_pending'
  /** Marked TIMED_OUT; a new request (attempt + 1) is scheduled after backoff. */
  | 'retry_scheduled'
  /** Marked TIMED_OUT after the last retry; application moved to IN_REVIEW (<KIND>_TIMEOUT). */
  | 'escalated'
  /** Marked TIMED_OUT, but the application is no longer VERIFYING, so nothing else happens. */
  | 'timed_out';

/**
 * The `verification_timeout` job, scheduled for every provider request. If
 * the request is still PENDING when it fires: mark it TIMED_OUT and either
 * re-request it (start_verifications for that kind, after exponential
 * backoff: attempt 2 after base, attempt 3 after 2*base) or, once
 * `verificationMaxRetries` retries have also timed out, move the application
 * to IN_REVIEW with a `<KIND>_TIMEOUT` review task. One transaction; a late
 * callback can still complete the TIMED_OUT row afterwards.
 */
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
