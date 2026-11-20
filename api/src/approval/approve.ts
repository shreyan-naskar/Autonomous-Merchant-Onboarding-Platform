import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import { applications, reviewTasks } from '../db/schema.js';
import type { Tx } from '../domain/guards.js';
import { transition } from '../domain/transition.js';
import { enqueueJob } from '../jobs/queue.js';
import { currentVerification } from '../verification/latest.js';
import type { VerificationDeps } from '../verification/start.js';

/** Every move into APPROVED is followed by a create_merchant job, in the same transaction. */
export function enqueueCreateMerchant(tx: Tx, appId: string, config: Config, now: number) {
  return enqueueJob(tx, 'create_merchant', { application_id: appId }, { now, maxAttempts: config.limits.merchantCreateMaxAttempts });
}

export type ApproveOutcome = 'approved' | 'high_risk' | 'skipped';

/**
 * The `approve` job (enqueued when evaluate() reaches VERIFIED). Risk score
 * <= RISK_THRESHOLD: VERIFIED -> APPROVED (actor system, AUTO_APPROVED) and
 * create_merchant is enqueued. Otherwise VERIFIED -> IN_REVIEW with a
 * HIGH_RISK review task (a missing score is treated as high risk).
 * Not in VERIFIED (already approved, bank changed, ...): no-op.
 */
export function runApprove(deps: VerificationDeps, appId: string): ApproveOutcome {
  const { db, config, logger, now } = deps;
  const threshold = config.thresholds.risk;
  const outcome = db.transaction(
    (tx): { outcome: ApproveOutcome; score?: number | null; status?: string } => {
      const app = tx.select().from(applications).where(eq(applications.id, appId)).get();
      if (!app || app.status !== 'VERIFIED') return { outcome: 'skipped', status: app?.status };

      const score = currentVerification(tx, app, 'RISK')?.score ?? null;
      if (score !== null && score <= threshold) {
        transition(tx, appId, 'APPROVED', {
          actor: 'system',
          event: 'AUTO_APPROVED',
          detail: { risk_score: score, risk_threshold: threshold, bank_version: app.bankVersion },
          now,
        });
        enqueueCreateMerchant(tx, appId, config, now);
        return { outcome: 'approved', score };
      }

      transition(tx, appId, 'IN_REVIEW', {
        actor: 'system',
        event: 'HIGH_RISK',
        detail: { reason: 'HIGH_RISK', risk_score: score, risk_threshold: threshold },
        now,
      });
      tx.insert(reviewTasks)
        .values({
          applicationId: appId,
          reason: 'HIGH_RISK',
          status: 'OPEN',
          note:
            score === null
              ? 'Risk check passed without a score; manual approval required'
              : `Risk score ${score} is above the auto-approval threshold of ${threshold}`,
          createdAt: now,
        })
        .run();
      return { outcome: 'high_risk', score };
    },
    { behavior: 'immediate' },
  );
  logger.info({ application_id: appId, outcome: outcome.outcome, risk_score: outcome.score, status: outcome.status }, 'approve');
  return outcome.outcome;
}
