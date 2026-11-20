import {
  REQUIRED_CHECKS,
  REVIEW_RESOLUTION_FROM,
  redactText,
  type ApplicationStatus,
  type AuditEvent,
  type ReviewRequest,
  type ReviewResolution,
  type VerificationKind,
} from '@app/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { enqueueCreateMerchant } from '../approval/approve.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { applications, reviewTasks, verifications, type Application } from '../db/schema.js';
import type { Tx } from '../domain/guards.js';
import { transition } from '../domain/transition.js';
import { AppError, ConflictError, IllegalTransitionError, NotFoundError } from '../errors.js';
import { enqueueJob } from '../jobs/queue.js';
import { currentVerification } from '../verification/latest.js';

/**
 * Target state and audit event per resolution. The states each one may be
 * used from are REVIEW_RESOLUTION_FROM (shared): narrower than
 * ALLOWED_TRANSITIONS, so RETRY_MERCHANT_CREATION cannot approve an
 * application under review and APPROVE cannot stand in for a retry.
 */
const TARGET: Record<ReviewResolution, { to: ApplicationStatus; event: AuditEvent }> = {
  APPROVE: { to: 'APPROVED', event: 'OPERATOR_APPROVED' },
  REJECT: { to: 'REJECTED', event: 'OPERATOR_REJECTED' },
  REQUEST_INFO: { to: 'NEEDS_INFO', event: 'OPERATOR_REQUESTED_INFO' },
  RETRY_VERIFICATION: { to: 'VERIFYING', event: 'OPERATOR_REVERIFY' },
  RETRY_MERCHANT_CREATION: { to: 'APPROVED', event: 'MERCHANT_CREATION_RETRY' },
};

const notPossible = (resolution: ReviewResolution, status: ApplicationStatus, to: ApplicationStatus) =>
  new AppError(`${resolution} is not possible while the application is ${status}`, 409, 'ILLEGAL_TRANSITION', {
    from: status,
    to,
    resolution,
  });

/**
 * Checks to re-run on RETRY_VERIFICATION: those whose current result is not
 * PASSED (failed, timed out, pending or never run). If all passed (e.g. a
 * HIGH_RISK review) every check is re-run.
 */
function kindsToRerun(tx: Tx, app: Application): VerificationKind[] {
  const notPassed = REQUIRED_CHECKS.filter((k) => currentVerification(tx, app, k)?.status !== 'PASSED');
  return notPassed.length > 0 ? notPassed : [...REQUIRED_CHECKS];
}

/**
 * Resolve an open review task with an operator decision, in one transaction:
 * the transition (actor operator; detail has the task, resolution and note),
 * the task update, and any follow-up job. A guard or illegal-transition
 * error rolls everything back and the task stays OPEN.
 *
 * - APPROVE / RETRY_MERCHANT_CREATION enqueue create_merchant.
 * - RETRY_VERIFICATION supersedes the current rows of the re-run kinds (so
 *   their attempt count restarts at 1) and enqueues start_verifications.
 *
 * @throws NotFoundError (app or task), ConflictError (task already resolved),
 *   GuardError (approval blocked), AppError ILLEGAL_TRANSITION (resolution not
 *   possible in the current state). All map to 404/409.
 */
export function resolveReview(db: Db, config: Config, appId: string, req: ReviewRequest, now: number): Application {
  return db.transaction(
    (tx) => {
      const app = tx.select().from(applications).where(eq(applications.id, appId)).get();
      if (!app) throw new NotFoundError('Application not found');
      const task = tx.select().from(reviewTasks).where(eq(reviewTasks.id, req.taskId)).get();
      if (!task || task.applicationId !== appId) throw new NotFoundError(`Review task ${req.taskId} not found for this application`);
      if (task.status !== 'OPEN') {
        throw new ConflictError(`Review task ${task.id} is already resolved (${task.resolution})`, { task_id: task.id, resolution: task.resolution });
      }

      const note = redactText(req.note);
      const { to, event } = TARGET[req.resolution];
      if (!REVIEW_RESOLUTION_FROM[req.resolution].includes(app.status)) throw notPossible(req.resolution, app.status, to);
      const detail: Record<string, unknown> = { task_id: task.id, task_reason: task.reason, resolution: req.resolution, note };

      let kinds: VerificationKind[] | undefined;
      if (req.resolution === 'RETRY_VERIFICATION') {
        kinds = kindsToRerun(tx, app);
        detail.kinds = kinds;
        tx.update(verifications)
          .set({ superseded: true })
          .where(and(eq(verifications.applicationId, appId), inArray(verifications.kind, kinds), eq(verifications.superseded, false)))
          .run();
      }

      let updated: Application;
      try {
        updated = transition(tx, appId, to, { actor: 'operator', event, detail, now });
      } catch (err) {
        if (err instanceof IllegalTransitionError) throw notPossible(req.resolution, app.status, to);
        throw err;
      }

      if (to === 'APPROVED') enqueueCreateMerchant(tx, appId, config, now);
      if (kinds) enqueueJob(tx, 'start_verifications', { application_id: appId, kinds }, { now });

      tx.update(reviewTasks)
        .set({ status: 'RESOLVED', resolution: req.resolution, resolutionNote: note, resolvedAt: now })
        .where(and(eq(reviewTasks.id, task.id), eq(reviewTasks.status, 'OPEN')))
        .run();
      return updated;
    },
    { behavior: 'immediate' },
  );
}
