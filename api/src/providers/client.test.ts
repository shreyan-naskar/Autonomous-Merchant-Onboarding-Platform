import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMockApp } from 'mock-providers';
import { afterEach, describe, expect, it } from 'vitest';
import type { Application } from '../db/schema.js';
import { buildProviderRequest, createHttpProviderClient, ProviderRequestError } from './client.js';
import { createFakeProviderClient } from './fake.js';

const app: Application = {
  id: 'app-1',
  status: 'VERIFYING',
  merchantName: 'Lakshmi Textiles Pvt Ltd',
  pan: 'AABCL1234K',
  gst: '27AABCL1234K1Z5',
  bankAccount: '50100234567891',
  ifsc: 'HDFC0001234',
  bankVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  stateEnteredAt: 0,
  merchantId: null,
};

describe('buildProviderRequest', () => {
  it('maps the application to each provider body', () => {
    expect(buildProviderRequest('PAN', app)).toEqual({ application_ref: 'app-1', pan: 'AABCL1234K' });
    expect(buildProviderRequest('GST', app)).toEqual({ application_ref: 'app-1', gstin: '27AABCL1234K1Z5' });
    expect(buildProviderRequest('BANK', app)).toEqual({
      application_ref: 'app-1',
      bank_account: '50100234567891',
      ifsc: 'HDFC0001234',
      bank_version: 2,
    });
    expect(buildProviderRequest('RISK', app)).toEqual({
      application_ref: 'app-1',
      merchant_name: 'Lakshmi Textiles Pvt Ltd',
      pan: 'AABCL1234K',
    });
  });

  it('throws (without the value) when a required field is missing', () => {
    expect(() => buildProviderRequest('BANK', { ...app, ifsc: null })).toThrow(/no ifsc/);
  });
});

describe('fake provider client', () => {
  it('records calls with predictable request ids and can be made to fail', async () => {
    const fake = createFakeProviderClient();
    expect(await fake.request('PAN', { application_ref: 'a', pan: 'X' })).toEqual({ request_id: 'fake-pan-1' });
    fake.failing.add('GST');
    await expect(fake.request('GST', { application_ref: 'a', gstin: 'Y' })).rejects.toBeInstanceOf(ProviderRequestError);
    expect(fake.calls.map((c) => c.kind)).toEqual(['PAN']);
    expect(fake.last('PAN')!.request_id).toBe('fake-pan-1');
  });
});

describe('HTTP provider client against the mock providers', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function startMock() {
    const mock = createMockApp({ webhookUrl: 'http://127.0.0.1:1/unused', hmacSecret: 's', chaos: { dropCallback: true } });
    server = mock.listen(0);
    await new Promise<void>((r) => server!.once('listening', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  it('returns the request_id for every kind', async () => {
    const client = createHttpProviderClient({ baseUrl: await startMock() });
    for (const kind of ['PAN', 'GST', 'BANK', 'RISK'] as const) {
      const { request_id } = await client.request(kind, buildProviderRequest(kind, app));
      expect(request_id).toMatch(new RegExp(`^${kind.toLowerCase()}_`));
    }
  });

  it('rejects with ProviderRequestError on a 400 and on an unreachable host', async () => {
    const client = createHttpProviderClient({ baseUrl: await startMock() });
    const err = await client.request('PAN', { application_ref: 'a' } as never).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err.status).toBe(400);

    const down = createHttpProviderClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1_000 });
    await expect(down.request('PAN', { application_ref: 'a', pan: 'AABCL1234K' })).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('rejects a 2xx response without a request_id', async () => {
    const client = createHttpProviderClient({
      baseUrl: 'http://x',
      fetch: (async () => new Response('{"ok":true}', { status: 202 })) as typeof fetch,
    });
    await expect(client.request('PAN', { application_ref: 'a', pan: 'P' })).rejects.toThrow(/no request_id/);
  });
});
