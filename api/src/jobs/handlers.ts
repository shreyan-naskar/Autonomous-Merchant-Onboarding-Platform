import { VerificationKindSchema } from '@app/shared';
import { z } from 'zod';
import { runApprove } from '../approval/approve.js';
import type { Db } from '../db/client.js';
import { runExtraction } from '../extraction/job.js';
import type { OcrEngine } from '../extraction/ocr.js';
import { runCreateMerchant } from '../merchant/create.js';
import { createSimulatedMerchantService, type MerchantService } from '../merchant/service.js';
import type { ProviderClient } from '../providers/client.js';
import { runStartVerifications } from '../verification/start.js';
import { runVerificationTimeout } from '../verification/timeout.js';
import type { JobHandlers } from './worker.js';

/** Such a job can never succeed, so fail loudly and let it dead-letter. */
function applicationId(payload: Record<string, unknown>): string {
  const id = payload.application_id;
  if (typeof id !== 'string' || id === '') throw new Error('Job payload has no application_id');
  return id;
}

const KindsSchema = z.array(VerificationKindSchema).min(1).optional();

interface JobHandlerDeps {
  providers: ProviderClient;
  /** Share the API's instance so the demo failure flag also applies to the worker. */
  merchantService?: MerchantService;
  ocr?: OcrEngine;
}

const noOcr: OcrEngine = {
  recognize: () => Promise.reject(new Error('OCR engine not configured')),
  terminate: () => Promise.resolve(),
};

export function createJobHandlers(deps: JobHandlerDeps): JobHandlers {
  const fallback = new WeakMap<Db, MerchantService>();
  const merchantService = (db: Db) => {
    if (deps.merchantService) return deps.merchantService;
    if (!fallback.has(db)) fallback.set(db, createSimulatedMerchantService(db));
    return fallback.get(db)!;
  };
  return {
    extract: async (payload, ctx) => {
      await runExtraction(ctx, deps.ocr ?? noOcr, applicationId(payload));
    },
    // bank_version marks a bank-change re-run.
    start_verifications: async (payload, ctx) => {
      await runStartVerifications(
        ctx,
        deps.providers,
        applicationId(payload),
        KindsSchema.parse(payload.kinds),
        z.number().int().optional().parse(payload.bank_version),
      );
    },
    verification_timeout: (payload, ctx) => {
      runVerificationTimeout(ctx, z.number().int().parse(payload.verification_id));
    },
    approve: (payload, ctx) => {
      runApprove(ctx, applicationId(payload));
    },
    create_merchant: async (payload, ctx) => {
      await runCreateMerchant(ctx, merchantService(ctx.db), applicationId(payload));
    },
  };
}
