import { redactText } from '@app/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { applications, reviewTasks } from '../db/schema.js';
import { transition } from '../domain/transition.js';
import type { JobRow } from '../jobs/worker.js';
import type { VerificationDeps } from '../verification/start.js';
import type { MerchantService } from './service.js';

export type CreateMerchantOutcome = 'created' | 'failed' | 'skipped';

/**
 * The `create_merchant` job (enqueued on every move into APPROVED).
 *
 * - Not APPROVED (already created, failed, ...): no-op.
 * - Asks the merchant service for an ID. The service is idempotent per
 *   application, and an ID already stored on the application is reused
 *   without calling it, so a retry or a duplicate job never creates a second MID.
 * - Service failure with attempts left: throw, so the worker retries with
 *   backoff (audit JOB_FAILED each time).
 * - Service failure on the last attempt: APPROVED -> MERCHANT_CREATION_FAILED
 *   plus a review task, and the job completes (no JOB_DEAD task on top).
 * - Success: store merchant_id and APPROVED -> MERCHANT_CREATED, one transaction.
 */
export async function runCreateMerchant(
  deps: VerificationDeps & { job: Pick<JobRow, 'attempts' | 'maxAttempts'> },
  service: MerchantService,
  appId: string,
): Promise<CreateMerchantOutcome> {
  const { db, logger, now, job } = deps;
  const app = db.select().from(applications).where(eq(applications.id, appId)).get();
  if (!app || app.status !== 'APPROVED') {
    logger.info({ application_id: appId, status: app?.status }, 'create_merchant: application not APPROVED, skipping');
    return 'skipped';
  }

  let merchantId = app.merchantId;
  if (!merchantId) {
    try {
      merchantId = (await service.createMerchant(appId, now)).merchantId;
    } catch (err) {
      const error = redactText((err as Error).message);
      if (job.attempts < job.maxAttempts) throw err;
      return db.transaction(
        (tx) => {
          const cur = tx.select({ status: applications.status }).from(applications).where(eq(applications.id, appId)).get();
          if (cur?.status !== 'APPROVED') return 'skipped';
          transition(tx, appId, 'MERCHANT_CREATION_FAILED', {
            actor: 'system',
            event: 'MERCHANT_CREATION_FAILED',
            detail: { attempts: job.attempts, error },
            now,
          });
          tx.insert(reviewTasks)
            .values({
              applicationId: appId,
              reason: 'MERCHANT_CREATION_FAILED',
              status: 'OPEN',
              note: `Merchant ID service failed ${job.attempts} time(s): ${error}. Use RETRY_MERCHANT_CREATION once it is back.`,
              createdAt: now,
            })
            .run();
          logger.error({ application_id: appId, attempts: job.attempts, error }, 'merchant creation failed');
          return 'failed' as const;
        },
        { behavior: 'immediate' },
      );
    }
  }

  return db.transaction(
    (tx) => {
      const cur = tx.select().from(applications).where(eq(applications.id, appId)).get();
      if (cur?.status !== 'APPROVED') return 'skipped';
      if (cur.merchantId === null) {
        tx.update(applications)
          .set({ merchantId, updatedAt: now })
          .where(and(eq(applications.id, appId), isNull(applications.merchantId)))
          .run();
      } else if (cur.merchantId !== merchantId) {
        throw new Error('Application already has a different merchant ID');
      }
      transition(tx, appId, 'MERCHANT_CREATED', {
        actor: 'system',
        event: 'MERCHANT_CREATED',
        detail: { merchant_id: merchantId, attempts: job.attempts },
        now,
      });
      logger.info({ application_id: appId, merchant_id: merchantId }, 'merchant created');
      return 'created' as const;
    },
    { behavior: 'immediate' },
  );
}
