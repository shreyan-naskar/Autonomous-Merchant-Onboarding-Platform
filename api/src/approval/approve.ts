import { and, eq } from 'drizzle-orm';
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

export type ApproveOutcome = 'approved' | 'high_risk' | 'possible_duplicate' | 'skipped';

/**
 * Risk is a score, not a failed check: above RISK_THRESHOLD (or missing) the
 * application waits for a person instead of being approved. An open
 * POSSIBLE_DUPLICATE task holds it the same way.
 */
export function runApprove(deps: VerificationDeps, appId: string): ApproveOutcome {
  const { db, config, logger, now } = deps;
  const threshold = config.thresholds.risk;
  const outcome = db.transaction(
    (tx): { outcome: ApproveOutcome; score?: number | null; status?: string } => {
      const app = tx.select().from(applications).where(eq(applications.id, appId)).get();
      if (!app || app.status !== 'VERIFIED') return { outcome: 'skipped', status: app?.status };

      const score = currentVerification(tx, app, 'RISK')?.score ?? null;
      const highRisk = score === null || score > threshold;
      const duplicateTasks = tx
        .select({ id: reviewTasks.id, related: reviewTasks.relatedApplicationId })
        .from(reviewTasks)
        .where(and(eq(reviewTasks.applicationId, appId), eq(reviewTasks.reason, 'POSSIBLE_DUPLICATE'), eq(reviewTasks.status, 'OPEN')))
        .all();

      if (!highRisk && duplicateTasks.length > 0) {
        transition(tx, appId, 'IN_REVIEW', {
          actor: 'system',
          event: 'POSSIBLE_DUPLICATE',
          detail: {
            reason: 'POSSIBLE_DUPLICATE',
            task_ids: duplicateTasks.map((t) => t.id),
            related_application_ids: duplicateTasks.map((t) => t.related),
            risk_score: score,
          },
          now,
        });
        return { outcome: 'possible_duplicate', score };
      }
      if (!highRisk) {
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
        detail: {
          reason: 'HIGH_RISK',
          risk_score: score,
          risk_threshold: threshold,
          ...(duplicateTasks.length > 0 ? { open_duplicate_task_ids: duplicateTasks.map((t) => t.id) } : {}),
        },
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
