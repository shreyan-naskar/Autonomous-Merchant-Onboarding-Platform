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
  outage: false,
};

export interface MockConfig {
  webhookUrl: string;
  hmacSecret: string;
  chaos?: Partial<ChaosConfig>;
  scheduler?: Scheduler;
  fetch?: typeof fetch;
  /** Never given request bodies (they contain PANs). */
  onDelivery?: (info: { event_id: string; kind: VerificationKind; status?: number; error?: string }) => void;
}

export type MockApp = Express & {
  readonly chaos: ChaosConfig;
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

function isSilent(kind: VerificationKind, req: ProviderRequest): boolean {
  return kind === 'BANK' && (req as ProviderRequest<'BANK'>).bank_account.endsWith(MAGIC.silentBankSuffix);
}

/** Each verify request answers 202 and later POSTs a signed callback, shaped by the chaos settings. */
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

  const sent = new Map<string, ProviderCallback>();
  const SENT_LIMIT = 1_000;

  async function deliver(callback: ProviderCallback): Promise<{ status?: number; response?: unknown; error?: string }> {
    const body = JSON.stringify(callback);
    sent.delete(callback.event_id);
    sent.set(callback.event_id, callback);
    if (sent.size > SENT_LIMIT) sent.delete(sent.keys().next().value!);
    try {
      const res = await doFetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signBody(config.hmacSecret, body) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const response = await res.json().catch(() => undefined);
      config.onDelivery?.({ event_id: callback.event_id, kind: callback.kind, status: res.status });
      return { status: res.status, response };
    } catch (err) {
      config.onDelivery?.({ event_id: callback.event_id, kind: callback.kind, error: (err as Error).message });
      return { error: (err as Error).message };
    }
  }

  for (const kind of VERIFICATION_KINDS) {
    app.post(PROVIDER_PATHS[kind], (req, res) => {
      if (chaos.outage) {
        res.status(503).json({ error: 'PROVIDER_UNAVAILABLE', message: `${kind} provider is down (demo outage)` });
        return;
      }
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

  app.post('/admin/reset', (_req, res) => {
    Object.assign(chaos, DEFAULT_CHAOS, config.chaos);
    sent.clear();
    res.json(chaos);
  });

  /** Byte-identical, identically signed redelivery: what a provider retry looks like to the API. */
  app.post('/admin/redeliver', async (req, res) => {
    const eventId = typeof req.body?.event_id === 'string' ? req.body.event_id : [...sent.keys()].at(-1);
    const callback = eventId ? sent.get(eventId) : undefined;
    if (!callback) {
      res.status(404).json({ error: 'UNKNOWN_EVENT', event_id: eventId ?? null });
      return;
    }
    const result = await deliver(callback);
    res.json({ event_id: callback.event_id, kind: callback.kind, api_status: result.status ?? null, api_response: result.response ?? null, error: result.error });
  });

  return app;
}
