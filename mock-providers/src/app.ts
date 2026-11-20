import { createHmac, randomUUID } from 'node:crypto';
import {
  ChaosConfigPatchSchema,
  MAGIC,
  PROVIDER_PATHS,
  PROVIDER_REQUEST_SCHEMAS,
  SIGNATURE_HEADER,
  VERIFICATION_KINDS,
  type ChaosConfig,
  type ProviderCallback,
  type ProviderRequest,
  type ProviderResult,
  type VerificationKind,
} from '@app/shared';
import express, { type Express } from 'express';
import { createRealScheduler, type Scheduler } from './scheduler.js';

export { createManualScheduler, createRealScheduler, type ManualScheduler, type Scheduler } from './scheduler.js';

export const DEFAULT_CHAOS: ChaosConfig = {
  delayMs: 1_500,
  failKinds: [],
  duplicateCallback: false,
  dropCallback: false,
  lateCallbackMs: 0,
};

export interface MockConfig {
  /** Where callbacks are POSTed (the API's /webhooks/provider). */
  webhookUrl: string;
  /** Shared secret for the X-Signature HMAC. */
  hmacSecret: string;
  /** Initial chaos settings (merged over DEFAULT_CHAOS). */
  chaos?: Partial<ChaosConfig>;
  scheduler?: Scheduler;
  fetch?: typeof fetch;
  /** Called for every callback attempt (tests, dev console). Never given request bodies. */
  onDelivery?: (info: { event_id: string; kind: VerificationKind; status?: number; error?: string }) => void;
}

export type MockApp = Express & {
  /** Current chaos settings (mutable via /admin/config). */
  readonly chaos: ChaosConfig;
  /** Resolves when all scheduled callbacks have been delivered (real scheduler). */
  settled(): Promise<void>;
};

export function signBody(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Deterministic low score (0-40) for ordinary names; 85 for names containing RISKY. */
export function riskScore(merchantName: string): number {
  if (merchantName.toUpperCase().includes(MAGIC.riskyNameToken)) return MAGIC.riskyScore;
  let h = 0;
  for (const ch of merchantName) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 41;
}

/** The provider's verdict for a request, from magic values and chaos failKinds. */
export function decide(kind: VerificationKind, req: ProviderRequest, chaos: ChaosConfig): ProviderResult {
  if (chaos.failKinds.includes(kind)) return { status: 'FAILED', reason: 'FORCED_FAILURE' };
  switch (kind) {
    case 'PAN':
      return (req as ProviderRequest<'PAN'>).pan.toUpperCase() === MAGIC.failingPan
        ? { status: 'FAILED', reason: 'PAN_NOT_FOUND' }
        : { status: 'PASSED' };
    case 'GST':
      return (req as ProviderRequest<'GST'>).gstin.toUpperCase().endsWith(MAGIC.failingGstSuffix)
        ? { status: 'FAILED', reason: 'GSTIN_INACTIVE' }
        : { status: 'PASSED' };
    case 'BANK':
      return { status: 'PASSED' };
    case 'RISK':
      return { status: 'PASSED', score: riskScore((req as ProviderRequest<'RISK'>).merchant_name) };
  }
}

/** Requests for which the mock never calls back. */
function isSilent(kind: VerificationKind, req: ProviderRequest): boolean {
  return kind === 'BANK' && (req as ProviderRequest<'BANK'>).bank_account.endsWith(MAGIC.silentBankSuffix);
}

/**
 * Mock PAN/GST/bank/risk providers. Each POST returns `202 {request_id}` and
 * later POSTs a signed callback to `webhookUrl`, shaped by the chaos settings.
 * Integration tests start this in-process on a random port.
 */
export function createMockApp(config: MockConfig): MockApp {
  const scheduler = config.scheduler ?? createRealScheduler();
  const doFetch = config.fetch ?? fetch;
  const chaos: ChaosConfig = { ...DEFAULT_CHAOS, ...config.chaos };
  const app = express() as MockApp;
  Object.defineProperty(app, 'chaos', { get: () => chaos });
  app.settled = () => scheduler.settled();

  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'mock-providers' });
  });

  async function deliver(callback: ProviderCallback): Promise<void> {
    const body = JSON.stringify(callback);
    try {
      const res = await doFetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signBody(config.hmacSecret, body) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      await res.arrayBuffer().catch(() => undefined);
      config.onDelivery?.({ event_id: callback.event_id, kind: callback.kind, status: res.status });
    } catch (err) {
      config.onDelivery?.({ event_id: callback.event_id, kind: callback.kind, error: (err as Error).message });
    }
  }

  for (const kind of VERIFICATION_KINDS) {
    app.post(PROVIDER_PATHS[kind], (req, res) => {
      const parsed = PROVIDER_REQUEST_SCHEMAS[kind].safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'INVALID_REQUEST', issues: parsed.error.issues.map((i) => i.path.join('.')) });
        return;
      }
      const body = parsed.data as ProviderRequest;
      const request_id = `${kind.toLowerCase()}_${randomUUID()}`;
      res.status(202).json({ request_id });

      // Settings are read at request time, so changing them affects only new requests.
      if (chaos.dropCallback || isSilent(kind, body)) return;
      const callback: ProviderCallback = {
        event_id: `evt_${randomUUID()}`,
        request_id,
        kind,
        result: decide(kind, body, chaos),
        application_ref: body.application_ref,
        ...(kind === 'BANK' ? { bank_version: (body as ProviderRequest<'BANK'>).bank_version } : {}),
      };
      const delay = chaos.lateCallbackMs > 0 ? chaos.lateCallbackMs : chaos.delayMs;
      const copies = chaos.duplicateCallback ? 2 : 1;
      scheduler.schedule(async () => {
        for (let i = 0; i < copies; i++) await deliver(callback);
      }, delay);
    });
  }

  app.get('/admin/config', (_req, res) => {
    res.json(chaos);
  });

  app.post('/admin/config', (req, res) => {
    const parsed = ChaosConfigPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'INVALID_CONFIG',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    Object.assign(chaos, parsed.data);
    res.json(chaos);
  });

  /** Restore DEFAULT_CHAOS merged with the startup chaos settings. */
  app.post('/admin/reset', (_req, res) => {
    Object.assign(chaos, DEFAULT_CHAOS, config.chaos);
    res.json(chaos);
  });

  return app;
}
