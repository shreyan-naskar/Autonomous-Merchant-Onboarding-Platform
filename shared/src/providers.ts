import { z } from 'zod';
import { VerificationKindSchema, type VerificationKind } from './domain.js';

/** Requests are answered 202; the result arrives later as a callback signed with HMAC-SHA256 over the raw body. */

export const SIGNATURE_HEADER = 'x-signature';

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

/** Risk is a score, not pass/fail: a high score sends the application to a reviewer instead of failing a check. */
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

export const ChaosConfigSchema = z.object({
  delayMs: z.number().int().min(0).max(600_000),
  failKinds: z.array(VerificationKindSchema),
  duplicateCallback: z.boolean(),
  dropCallback: z.boolean(),
  /** When > 0, replaces delayMs; longer than the API's timeout, so the answer arrives late. */
  lateCallbackMs: z.number().int().min(0).max(3_600_000),
  outage: z.boolean(),
});
export type ChaosConfig = z.infer<typeof ChaosConfigSchema>;
export const ChaosConfigPatchSchema = ChaosConfigSchema.partial().strict();

/** Documented in sample-data/README.md. */
export const MAGIC = {
  failingPan: 'ZZZZZ9999Z',
  failingGstSuffix: 'Z9',
  silentBankSuffix: '0000',
  riskyNameToken: 'RISKY',
  riskyScore: 85,
} as const;
