import { and, desc, eq, like } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { applications, auditLog, jobs, reviewTasks } from '../db/schema.js';
import { ConflictError, NotFoundError } from '../errors.js';

/*
 * Dead-letter queue (Phase 7.3): jobs with status `dead` (attempts exhausted
 * or no handler), listed for the operator and requeued on demand.
 */

export type JobRow = typeof jobs.$inferSelect;

export function listDeadJobs(db: Db, { limit = 200 }: { limit?: number } = {}): JobRow[] {
  return db.select().from(jobs).where(eq(jobs.status, 'dead')).orderBy(desc(jobs.updatedAt), desc(jobs.id)).limit(limit).all();
}

const applicationIdOf = (job: JobRow) => {
  const id = (job.payload as Record<string, unknown> | null)?.application_id;
  return typeof id === 'string' ? id : undefined;
};

/**
 * Put a dead job back in the queue: status queued, attempts reset to 0,
 * due now. last_error is kept until the next attempt overwrites it. If the
 * job belongs to an application, writes audit JOB_REQUEUED (actor operator)
 * and resolves the open JOB_DEAD task the worker opened for this job
 * (resolution REQUEUED). One transaction.
 *
 * @throws NotFoundError (no such job), ConflictError (job is not dead).
 */
export function requeueJob(db: Db, jobId: number, { now }: { now: number }): JobRow {
  return db.transaction(
    (tx) => {
      const job = tx.select().from(jobs).where(eq(jobs.id, jobId)).get();
      if (!job) throw new NotFoundError(`Job ${jobId} not found`);
      if (job.status !== 'dead') throw new ConflictError(`Job ${jobId} is ${job.status}, only dead jobs can be requeued`, { status: job.status });

      const updated = tx
        .update(jobs)
        .set({ status: 'queued', attempts: 0, runAt: now, updatedAt: now })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'dead')))
        .returning()
        .get();

      const appId = applicationIdOf(job);
      const app = appId ? tx.select({ status: applications.status }).from(applications).where(eq(applications.id, appId)).get() : undefined;
      if (appId && app) {
        tx.insert(auditLog)
          .values({
            applicationId: appId,
            at: now,
            actor: 'operator',
            fromState: app.status,
            toState: null,
            event: 'JOB_REQUEUED',
            detail: { job_id: job.id, type: job.type, previous_attempts: job.attempts, last_error: job.lastError },
          })
          .run();
        // The worker's JOB_DEAD note starts "Job <type> #<id> failed".
        tx.update(reviewTasks)
          .set({ status: 'RESOLVED', resolution: 'REQUEUED', resolutionNote: 'Job requeued from the dead-letter view', resolvedAt: now })
          .where(
            and(
              eq(reviewTasks.applicationId, appId),
              eq(reviewTasks.reason, 'JOB_DEAD'),
              eq(reviewTasks.status, 'OPEN'),
              like(reviewTasks.note, `Job ${job.type} #${job.id} failed%`),
            ),
          )
          .run();
      }
      return updated;
    },
    { behavior: 'immediate' },
  );
}
