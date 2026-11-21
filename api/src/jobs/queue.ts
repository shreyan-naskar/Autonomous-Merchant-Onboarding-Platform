import type { JobType } from '@app/shared';
import type { Db } from '../db/client.js';
import type { Tx } from '../domain/guards.js';
import { jobs } from '../db/schema.js';

export interface EnqueueOptions {
  runAt?: number;
  maxAttempts?: number;
  now?: number;
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
