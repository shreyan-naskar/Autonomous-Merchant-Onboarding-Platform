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

/** A job whose payload lacks application_id can never succeed; fail loudly (it will dead-letter). */
function applicationId(payload: Record<string, unknown>): string {
  const id = payload.application_id;
  if (typeof id !== 'string' || id === '') throw new Error('Job payload has no application_id');
  return id;
}

const KindsSchema = z.array(VerificationKindSchema).min(1).optional();

export interface JobHandlerDeps {
  providers: ProviderClient;
  /**
   * Merchant ID service. Share one instance with createApp so the runtime
   * failure flag (POST /admin/merchant-service) applies to the worker.
   * Defaults to a simulated service on the job's DB.
   */
  merchantService?: MerchantService;
  /**
   * OCR for uploaded images (extract job only). Required only when an
   * application has an uploaded image that passes the blur check; without
   * it such a job fails and is retried / dead-lettered.
   */
  ocr?: OcrEngine;
}

const noOcr: OcrEngine = {
  recognize: () => Promise.reject(new Error('OCR engine not configured')),
  terminate: () => Promise.resolve(),
};

/** The job registry, keyed by job type. Types without a handler are dead-lettered on first run. */
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
    // payload: { application_id, kinds?: VerificationKind[], bank_version?: number }
    // (kinds defaults to all required checks; bank_version marks a bank-change re-run)
    start_verifications: async (payload, ctx) => {
      await runStartVerifications(
        ctx,
        deps.providers,
        applicationId(payload),
        KindsSchema.parse(payload.kinds),
        z.number().int().optional().parse(payload.bank_version),
      );
    },
    // payload: { application_id, verification_id }; scheduled per provider request.
    verification_timeout: (payload, ctx) => {
      runVerificationTimeout(ctx, z.number().int().parse(payload.verification_id));
    },
    // Enqueued by evaluate() on VERIFIED: auto-approve, or IN_REVIEW HIGH_RISK.
    approve: (payload, ctx) => {
      runApprove(ctx, applicationId(payload));
    },
    // Enqueued on every move into APPROVED.
    create_merchant: async (payload, ctx) => {
      await runCreateMerchant(ctx, merchantService(ctx.db), applicationId(payload));
    },
  };
}
