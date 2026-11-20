import {
  PROVIDER_PATHS,
  ProviderAcceptedSchema,
  type ProviderAccepted,
  type ProviderRequest,
  type VerificationKind,
} from '@app/shared';
import type { Application } from '../db/schema.js';

/**
 * Starts an asynchronous provider check. Resolves with the provider's
 * request_id once the request is accepted; the outcome arrives later as a
 * signed callback. Rejects if the provider cannot be reached or refuses.
 */
export interface ProviderClient {
  request<K extends VerificationKind>(kind: K, body: ProviderRequest<K>): Promise<ProviderAccepted>;
}

export class ProviderRequestError extends Error {
  constructor(
    readonly kind: VerificationKind,
    message: string,
    readonly status?: number,
  ) {
    super(`${kind} provider request failed: ${message}`);
    this.name = 'ProviderRequestError';
  }
}

/** The request body for one check, built from the application's current form values. */
export function buildProviderRequest(kind: VerificationKind, app: Application): ProviderRequest {
  const need = (value: string | null, field: string) => {
    if (!value) throw new ProviderRequestError(kind, `application has no ${field}`);
    return value;
  };
  const application_ref = app.id;
  switch (kind) {
    case 'PAN':
      return { application_ref, pan: need(app.pan, 'pan') };
    case 'GST':
      return { application_ref, gstin: need(app.gst, 'gst') };
    case 'BANK':
      return {
        application_ref,
        bank_account: need(app.bankAccount, 'bank_account'),
        ifsc: need(app.ifsc, 'ifsc'),
        bank_version: app.bankVersion,
      };
    case 'RISK':
      return { application_ref, merchant_name: app.merchantName, ...(app.pan ? { pan: app.pan } : {}) };
  }
}

export interface HttpProviderClientOptions {
  baseUrl: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** ProviderClient over HTTP (the mock providers, or a real gateway with the same contract). */
export function createHttpProviderClient(opts: HttpProviderClientOptions): ProviderClient {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  return {
    async request(kind, body) {
      let res: Response;
      try {
        res = await doFetch(`${base}${PROVIDER_PATHS[kind]}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
        });
      } catch (err) {
        // Network error messages never contain the body; keep only the cause.
        throw new ProviderRequestError(kind, (err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message);
      }
      const text = await res.text().catch(() => '');
      if (res.status !== 202 && res.status !== 200) throw new ProviderRequestError(kind, `HTTP ${res.status}`, res.status);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderRequestError(kind, 'response is not JSON', res.status);
      }
      const parsed = ProviderAcceptedSchema.safeParse(json);
      if (!parsed.success) throw new ProviderRequestError(kind, 'response has no request_id', res.status);
      return parsed.data;
    },
  };
}
