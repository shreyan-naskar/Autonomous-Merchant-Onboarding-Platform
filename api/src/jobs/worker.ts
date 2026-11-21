import { redactText, type JobType } from '@app/shared';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { applications, auditLog, jobs, reviewTasks } from '../db/schema.js';
import type { Logger } from '../logger.js';

export type JobRow = typeof jobs.$inferSelect;

export interface JobContext {
  db: Db;
  config: Config;
  logger: Logger;
  /** Handlers use this, never Date.now(), so tests can drive time. */
  now: number;
  job: JobRow;
}

/** Throwing counts as a failed attempt. Handlers must be idempotent: a retry can follow a partial run. */
export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => void | Promise<void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export interface WorkerDeps {
  db: Db;
  config: Config;
  logger: Logger;
  handlers: JobHandlers;
  batchSize?: number;
}

export interface TickResult {
  claimed: number;
  done: number;
  retried: number;
  dead: number;
}

export function backoffDelayMs(baseMs: number, attempts: number): number {
  return baseMs * 2 ** Math.max(0, attempts - 1);
}

/** One UPDATE ... RETURNING: the status check and the claim are a single statement, so a job is claimed at most once. */
export function claimDueJobs(db: Db, now: number, limit: number): JobRow[] {
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, 'queued'), lte(jobs.runAt, now)))
    .orderBy(asc(jobs.runAt), asc(jobs.id))
    .limit(limit);
  return db
    .update(jobs)
    .set({ status: 'running', attempts: sql`${jobs.attempts} + 1`, updatedAt: now })
    .where(and(eq(jobs.status, 'queued'), inArray(jobs.id, due)))
    .returning()
    .all()
    .sort((a, b) => a.runAt - b.runAt || a.id - b.id);
}

const applicationIdOf = (job: JobRow): string | undefined => {
  const id = (job.payload as Record<string, unknown> | null)?.application_id;
  return typeof id === 'string' ? id : undefined;
};

/** Errors are stored and shown, so PAN / account-shaped text is masked first. */
const errorText = (err: unknown) => redactText(err instanceof Error ? err.message : String(err)).slice(0, 500);

/** Retry with exponential backoff, then dead-letter with a JOB_DEAD review task. Jobs without an application are only logged. */
function recordFailure(deps: WorkerDeps, job: JobRow, err: unknown, now: number, permanent: boolean): 'retried' | 'dead' {
  const { db, config, logger } = deps;
  const error = errorText(err);
  const dead = permanent || job.attempts >= job.maxAttempts;
  const nextRunAt = dead ? null : now + backoffDelayMs(config.timings.backoffBaseMs, job.attempts);

  db.transaction(
    (tx) => {
      tx.update(jobs)
        .set({
          status: dead ? 'dead' : 'queued',
          runAt: nextRunAt ?? job.runAt,
          lastError: error,
          updatedAt: now,
        })
        .where(eq(jobs.id, job.id))
        .run();

      const appId = applicationIdOf(job);
      const app = appId
        ? tx.select({ status: applications.status }).from(applications).where(eq(applications.id, appId)).get()
        : undefined;
      if (!appId || !app) return;

      const detail = { job_id: job.id, type: job.type, attempts: job.attempts, max_attempts: job.maxAttempts, error };
      tx.insert(auditLog)
        .values({
          applicationId: appId,
          at: now,
          actor: 'system',
          fromState: app.status,
          toState: null,
          event: dead ? 'JOB_DEAD' : 'JOB_FAILED',
          detail: dead ? detail : { ...detail, next_run_at: new Date(nextRunAt!).toISOString() },
        })
        .run();
      if (dead) {
        tx.insert(reviewTasks)
          .values({
            applicationId: appId,
            reason: 'JOB_DEAD',
            status: 'OPEN',
            note: `Job ${job.type} #${job.id} failed ${job.attempts} time(s): ${error}`,
            createdAt: now,
          })
          .run();
      }
    },
    { behavior: 'immediate' },
  );

  const log = { job_id: job.id, type: job.type, attempts: job.attempts, application_id: applicationIdOf(job), error };
  if (dead) logger.error(log, 'job dead-lettered');
  else logger.warn({ ...log, next_run_at: nextRunAt }, 'job failed, retry scheduled');
  return dead ? 'dead' : 'retried';
}

/** Jobs enqueued during a tick run on a later tick. Never throws for a handler error. */
export async function runDueJobsOnce(deps: WorkerDeps, now: number): Promise<TickResult> {
  const claimed = claimDueJobs(deps.db, now, deps.batchSize ?? 10);
  const result: TickResult = { claimed: claimed.length, done: 0, retried: 0, dead: 0 };

  for (const job of claimed) {
    const handler = deps.handlers[job.type as JobType];
    if (!handler) {
      // Retrying cannot help: dead-letter immediately.
      result[recordFailure(deps, job, new Error(`No handler for job type ${job.type}`), now, true)]++;
      continue;
    }
    try {
      await handler((job.payload ?? {}) as Record<string, unknown>, { ...deps, now, job });
      deps.db.update(jobs).set({ status: 'done', updatedAt: now }).where(eq(jobs.id, job.id)).run();
      result.done++;
    } catch (err) {
      result[recordFailure(deps, job, err, now, false)]++;
    }
  }
  return result;
}

export interface Worker {
  stop(): Promise<void>;
}

/** Ticks never overlap: a tick still running makes the next interval a no-op. */
export function startWorker(deps: WorkerDeps, { now = Date.now, intervalMs }: { now?: () => number; intervalMs?: number } = {}): Worker {
  let inFlight: Promise<unknown> | null = null;
  const tick = () => {
    if (inFlight) return;
    inFlight = runDueJobsOnce(deps, now())
      .catch((err) => deps.logger.error({ err }, 'worker tick failed'))
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = setInterval(tick, intervalMs ?? deps.config.timings.workerPollMs);
  timer.unref?.();
  deps.logger.info({ interval_ms: intervalMs ?? deps.config.timings.workerPollMs }, 'worker started');
  return {
    async stop() {
      clearInterval(timer);
      await inFlight;
    },
  };
}
