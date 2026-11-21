import { z } from 'zod';
import { VerificationKindSchema, type VerificationKind } from './domain.js';

/**
 * Wire contract between the API and the (mock) verification providers.
 * Requests are answered `202 {request_id}`; the outcome arrives later as a
 * signed callback (X-Signature = hex HMAC-SHA256 of the raw body).
 */

export const SIGNATURE_HEADER = 'x-signature';

/** Provider endpoint per verification kind. */
export const PROVIDER_PATHS: Record<VerificationKind, string> = {
  PAN: '/pan/verify',
  GST: '/gst/verify',
  BANK: '/bank/verify',
  RISK: '/risk/score',
};

const Ref = z.string().min(1).max(100);

export const PanRequestSchema = z.object({ application_ref: Ref, pan: z.string().min(1).max(20) });
export const GstRequestSchema = z.object({ application_ref: Ref, gstin: z.string().min(1).max(20) });
export const BankRequestSchema = z.object({
  application_ref: Ref,
  bank_account: z.string().min(1).max(30),
  ifsc: z.string().min(1).max(20),
  bank_version: z.number().int().min(1),
});
export const RiskRequestSchema = z.object({
  application_ref: Ref,
  merchant_name: z.string().min(1).max(300),
  pan: z.string().max(20).optional(),
});

export const PROVIDER_REQUEST_SCHEMAS = {
  PAN: PanRequestSchema,
  GST: GstRequestSchema,
  BANK: BankRequestSchema,
  RISK: RiskRequestSchema,
} as const;

export type ProviderRequest<K extends VerificationKind = VerificationKind> = z.infer<(typeof PROVIDER_REQUEST_SCHEMAS)[K]>;

export const ProviderAcceptedSchema = z.object({ request_id: z.string().min(1) });
export type ProviderAccepted = z.infer<typeof ProviderAcceptedSchema>;

/** Outcome of one check. Risk always carries a 0-100 score; a high score is not a failure. */
export const ProviderResultSchema = z.object({
  status: z.enum(['PASSED', 'FAILED']),
  reason: z.string().max(100).optional(),
  score: z.number().int().min(0).max(100).optional(),
});
export type ProviderResult = z.infer<typeof ProviderResultSchema>;

export const ProviderCallbackSchema = z.object({
  event_id: z.string().min(1).max(100),
  request_id: z.string().min(1).max(100),
  kind: VerificationKindSchema,
  result: ProviderResultSchema,
  application_ref: Ref,
  /** Echoed from the BANK request so the API can drop results for an old bank account. */
  bank_version: z.number().int().min(1).optional(),
});
export type ProviderCallback = z.infer<typeof ProviderCallbackSchema>;

/** Global chaos settings of the mock providers (POST/GET /admin/config). */
export const ChaosConfigSchema = z.object({
  /** Delay before a callback is sent. */
  delayMs: z.number().int().min(0).max(600_000),
  /** Kinds that always fail. */
  failKinds: z.array(VerificationKindSchema),
  /** Send each callback twice with the same event_id. */
  duplicateCallback: z.boolean(),
  /** Never send callbacks (the API times out). */
  dropCallback: z.boolean(),
  /** When > 0, callbacks are sent after this delay instead of delayMs (after the API's timeout). */
  lateCallbackMs: z.number().int().min(0).max(3_600_000),
  /** Provider outage: every verify request is refused with 503 (nothing is sent back). */
  outage: z.boolean(),
});
export type ChaosConfig = z.infer<typeof ChaosConfigSchema>;
export const ChaosConfigPatchSchema = ChaosConfigSchema.partial().strict();

/** Magic values understood by the mock providers (documented in sample-data/README.md). */
export const MAGIC = {
  failingPan: 'ZZZZZ9999Z',
  failingGstSuffix: 'Z9',
  silentBankSuffix: '0000',
  riskyNameToken: 'RISKY',
  riskyScore: 85,
} as const;
