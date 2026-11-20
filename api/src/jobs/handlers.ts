import { VerificationKindSchema } from '@app/shared';
import { z } from 'zod';
import { runExtraction } from '../extraction/job.js';
import type { ProviderClient } from '../providers/client.js';
import { runStartVerifications } from '../verification/start.js';
import type { JobHandlers } from './worker.js';

/** A job whose payload lacks application_id can never succeed; fail loudly (it will dead-letter). */
function applicationId(payload: Record<string, unknown>): string {
  const id = payload.application_id;
  if (typeof id !== 'string' || id === '') throw new Error('Job payload has no application_id');
  return id;
}

const KindsSchema = z.array(VerificationKindSchema).min(1).optional();

export interface JobHandlerDeps {
  providers: ProviderClient;
}

/** The job registry, keyed by job type. Types without a handler are dead-lettered on first run. */
export function createJobHandlers(deps: JobHandlerDeps): JobHandlers {
  return {
    extract: (payload, ctx) => {
      runExtraction(ctx, applicationId(payload));
    },
    // payload: { application_id, kinds?: VerificationKind[] } (kinds defaults to all required checks)
    start_verifications: async (payload, ctx) => {
      await runStartVerifications(ctx, deps.providers, applicationId(payload), KindsSchema.parse(payload.kinds));
    },
    // Enqueued by evaluate() on VERIFIED. Stub until Phase 5 adds auto-approval.
    approve: (payload, ctx) => {
      ctx.logger.info({ application_id: applicationId(payload) }, 'approve: stub (Phase 5)');
    },
  };
}
