import {
  INFORMATIONAL_TASK_REASONS,
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
import { applications, auditLog, reviewTasks, verifications, type Application } from '../db/schema.js';
import type { Tx } from '../domain/guards.js';
import { transition } from '../domain/transition.js';
import { AppError, ConflictError, IllegalTransitionError, NotFoundError } from '../errors.js';
import { enqueueJob } from '../jobs/queue.js';
import { currentVerification } from '../verification/latest.js';

const TARGET: Record<Exclude<ReviewResolution, 'DISMISS'>, { to: ApplicationStatus; event: AuditEvent }> = {
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

/** Re-run what has not passed; if everything passed (e.g. a HIGH_RISK review), re-run all four. */
function kindsToRerun(tx: Tx, app: Application): VerificationKind[] {
  const notPassed = REQUIRED_CHECKS.filter((k) => currentVerification(tx, app, k)?.status !== 'PASSED');
  return notPassed.length > 0 ? notPassed : [...REQUIRED_CHECKS];
}

/** One transaction: a guard or illegal-transition error rolls everything back and the task stays OPEN. */
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
      const detail: Record<string, unknown> = { task_id: task.id, task_reason: task.reason, resolution: req.resolution, note };
      const closeTask = () =>
        tx.update(reviewTasks)
          .set({ status: 'RESOLVED', resolution: req.resolution, resolutionNote: note, resolvedAt: now })
          .where(and(eq(reviewTasks.id, task.id), eq(reviewTasks.status, 'OPEN')))
          .run();

      if (req.resolution === 'DISMISS') {
        if (!INFORMATIONAL_TASK_REASONS.includes(task.reason)) {
          throw new AppError(`A ${task.reason} task cannot be dismissed; choose a decision`, 409, 'NOT_DISMISSIBLE', {
            task_reason: task.reason,
          });
        }
        if (!REVIEW_RESOLUTION_FROM.DISMISS.includes(app.status)) throw notPossible(req.resolution, app.status, app.status);
        tx.insert(auditLog)
          .values({ applicationId: appId, at: now, actor: 'operator', fromState: app.status, toState: null, event: 'REVIEW_TASK_DISMISSED', detail })
          .run();
        closeTask();
        return app;
      }

      const { to, event } = TARGET[req.resolution];
      if (!REVIEW_RESOLUTION_FROM[req.resolution].includes(app.status)) throw notPossible(req.resolution, app.status, to);

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

      closeTask();
      return updated;
    },
    { behavior: 'immediate' },
  );
}
