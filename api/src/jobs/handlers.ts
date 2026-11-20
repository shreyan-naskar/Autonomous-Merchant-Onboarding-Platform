import { runExtraction } from '../extraction/job.js';
import type { JobHandlers } from './worker.js';

/** A job whose payload lacks application_id can never succeed; fail loudly (it will dead-letter). */
function applicationId(payload: Record<string, unknown>): string {
  const id = payload.application_id;
  if (typeof id !== 'string' || id === '') throw new Error('Job payload has no application_id');
  return id;
}

/** The job registry, keyed by job type. Types without a handler are dead-lettered on first run. */
export function createJobHandlers(): JobHandlers {
  return {
    extract: (payload, ctx) => {
      runExtraction(ctx, applicationId(payload));
    },
    // Stub until Phase 4 calls the mock providers.
    start_verifications: (payload, ctx) => {
      ctx.logger.info({ application_id: applicationId(payload) }, 'start_verifications: stub (Phase 4)');
    },
  };
}
