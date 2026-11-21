import type { JobType } from '@app/shared';
import type { Db } from '../db/client.js';
import type { Tx } from '../domain/guards.js';
import { jobs } from '../db/schema.js';

interface EnqueueOptions {
  runAt?: number;
  maxAttempts?: number;
  now?: number;
}

/** The application a job belongs to, if its payload names one. */
export function jobApplicationId(job: { payload: unknown }): string | undefined {
  const id = (job.payload as Record<string, unknown> | null)?.application_id;
  return typeof id === 'string' ? id : undefined;
}

/** Pass the caller's transaction so the job commits or rolls back with the state change that caused it. */
export function enqueueJob(db: Db | Tx, type: JobType, payload: Record<string, unknown>, opts: EnqueueOptions = {}) {
  const now = opts.now ?? Date.now();
  return db
    .insert(jobs)
    .values({
      type,
      payload,
      runAt: opts.runAt ?? now,
      maxAttempts: opts.maxAttempts ?? 5,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}
