import type { AddressInfo } from 'node:net';
import { ProviderCallbackSchema, type ChaosConfig, type ProviderCallback } from '@app/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createManualScheduler, createMockApp, riskScore, signBody, type ManualScheduler, type MockApp } from './app.js';

const SECRET = 'test-secret';
const WEBHOOK = 'http://api.test/webhooks/provider';

interface Sent {
  url: string;
  body: string;
  signature: string;
  callback: ProviderCallback;
}

let sched: ManualScheduler;
let sent: Sent[];
let app: MockApp;

function makeApp(chaos: Partial<ChaosConfig> = {}) {
  sched = createManualScheduler();
  sent = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = init.body as string;
    const headers = init.headers as Record<string, string>;
    sent.push({ url, body, signature: headers['x-signature']!, callback: ProviderCallbackSchema.parse(JSON.parse(body)) });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  app = createMockApp({ webhookUrl: WEBHOOK, hmacSecret: SECRET, scheduler: sched, fetch: fakeFetch, chaos: { delayMs: 1_000, ...chaos } });
  return app;
}

beforeEach(() => {
  makeApp();
});

const happy = {
  PAN: ['/pan/verify', { application_ref: 'app-1', pan: 'AABCL1234K' }],
  GST: ['/gst/verify', { application_ref: 'app-1', gstin: '27AABCL1234K1Z5' }],
  BANK: ['/bank/verify', { application_ref: 'app-1', bank_account: '50100234567891', ifsc: 'HDFC0001234', bank_version: 3 }],
  RISK: ['/risk/score', { application_ref: 'app-1', merchant_name: 'Lakshmi Textiles Pvt Ltd' }],
} as const;

async function call(path: string, body: object) {
  const res = await request(app).post(path).send(body);
  expect(res.status).toBe(202);
  expect(res.body.request_id).toEqual(expect.any(String));
  return res.body.request_id as string;
}

describe('mock providers', () => {
  it('starts in-process on a random port and serves /health', async () => {
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', service: 'mock-providers' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('each endpoint returns 202 {request_id} and calls back after delayMs with a valid signature', async () => {
    const ids: Record<string, string> = {};
    for (const [kind, [path, body]] of Object.entries(happy)) ids[kind] = await call(path, body);
    expect(new Set(Object.values(ids)).size).toBe(4);

    expect(await sched.advance(999)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await sched.advance(1)).toBe(4);

    expect(sent.map((s) => s.callback.kind)).toEqual(['PAN', 'GST', 'BANK', 'RISK']);
    for (const s of sent) {
      expect(s.url).toBe(WEBHOOK);
      expect(s.signature).toBe(signBody(SECRET, s.body));
      expect(s.callback.request_id).toBe(ids[s.callback.kind]);
      expect(s.callback.application_ref).toBe('app-1');
      expect(s.callback.result.status).toBe('PASSED');
    }
    expect(sent.find((s) => s.callback.kind === 'BANK')!.callback.bank_version).toBe(3);
    expect(sent.find((s) => s.callback.kind === 'PAN')!.callback.bank_version).toBeUndefined();
    const risk = sent.find((s) => s.callback.kind === 'RISK')!.callback.result.score!;
    expect(risk).toBeGreaterThanOrEqual(0);
    expect(risk).toBeLessThanOrEqual(40);
    // Callbacks carry no PAN, GSTIN or account number.
    expect(sent.map((s) => s.body).join()).not.toMatch(/AABCL1234K|50100234567891/);
  });

  it('magic values: PAN ZZZZZ9999Z fails, GST ending Z9 fails, RISKY scores 85', async () => {
    await call('/pan/verify', { application_ref: 'a', pan: 'ZZZZZ9999Z' });
    await call('/gst/verify', { application_ref: 'a', gstin: '29AACCM5678P1Z9' });
    await call('/risk/score', { application_ref: 'a', merchant_name: 'Very Risky Traders' });
    await sched.advance(1_000);
    expect(sent.map((s) => [s.callback.kind, s.callback.result])).toEqual([
      ['PAN', { status: 'FAILED', reason: 'PAN_NOT_FOUND' }],
      ['GST', { status: 'FAILED', reason: 'GSTIN_INACTIVE' }],
      ['RISK', { status: 'PASSED', score: 85 }],
    ]);
  });

  it('bank account ending 0000 never calls back', async () => {
    await call('/bank/verify', { ...happy.BANK[1], bank_account: '50100234560000' });
    await sched.advance(3_600_000);
    expect(sent).toHaveLength(0);
    expect(sched.pending()).toBe(0);
  });

  it('risk score is deterministic and within 0-100', () => {
    expect(riskScore('Acme')).toBe(riskScore('Acme'));
    for (const n of ['a', 'Lakshmi Textiles', 'Zed & Co', 'x'.repeat(300)]) {
      expect(riskScore(n)).toBeGreaterThanOrEqual(0);
      expect(riskScore(n)).toBeLessThanOrEqual(100);
    }
    expect(riskScore('risky business')).toBe(85);
  });

  it('rejects malformed requests with 400 and sends nothing', async () => {
    const res = await request(app).post('/pan/verify').send({ application_ref: 'a' });
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual(['pan']);
    await sched.advance(10_000);
    expect(sent).toHaveLength(0);
  });
});

describe('chaos settings', () => {
  it('GET /admin/config returns the settings; POST merges a validated patch', async () => {
    expect((await request(app).get('/admin/config')).body).toEqual({
      delayMs: 1_000,
      failKinds: [],
      duplicateCallback: false,
      dropCallback: false,
      lateCallbackMs: 0,
      outage: false,
    });
    const res = await request(app).post('/admin/config').send({ failKinds: ['GST'], duplicateCallback: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ delayMs: 1_000, failKinds: ['GST'], duplicateCallback: true });
    expect(app.chaos.failKinds).toEqual(['GST']);

    for (const bad of [{ failKinds: ['FOO'] }, { delayMs: -1 }, { unknown: true }]) {
      expect((await request(app).post('/admin/config').send(bad)).status).toBe(400);
    }
    expect(app.chaos.failKinds).toEqual(['GST']);

    await request(app).post('/admin/reset').expect(200);
    expect(app.chaos).toMatchObject({ delayMs: 1_000, failKinds: [], duplicateCallback: false });
  });

  it('failKinds forces a failure for that kind only', async () => {
    await request(app).post('/admin/config').send({ failKinds: ['BANK'] });
    await call(...happy.PAN);
    await call(...happy.BANK);
    await sched.advance(1_000);
    expect(sent.map((s) => [s.callback.kind, s.callback.result.status])).toEqual([
      ['PAN', 'PASSED'],
      ['BANK', 'FAILED'],
    ]);
  });

  it('duplicateCallback sends the same event twice', async () => {
    makeApp({ duplicateCallback: true });
    await call(...happy.PAN);
    await sched.advance(1_000);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toBe(sent[1]!.body);
    expect(sent[0]!.callback.event_id).toBe(sent[1]!.callback.event_id);
  });

  it('POST /admin/redeliver resends one delivered callback, byte-identical and identically signed', async () => {
    await call(...happy.PAN);
    await call(...happy.GST);
    await sched.advance(1_000);
    expect(sent).toHaveLength(2);

    const res = await request(app).post('/admin/redeliver').send({ event_id: sent[0]!.callback.event_id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: sent[0]!.callback.event_id, kind: 'PAN', api_status: 200, api_response: {} });
    expect(sent).toHaveLength(3);
    expect(sent[2]!.body).toBe(sent[0]!.body);
    expect(sent[2]!.signature).toBe(sent[0]!.signature);

    // Default: the most recent delivery (now the redelivered PAN callback).
    await request(app).post('/admin/redeliver').send({}).expect(200);
    expect(sent[3]!.body).toBe(sent[0]!.body);
  });

  it('POST /admin/redeliver: 404 for an unknown event, and after /admin/reset', async () => {
    await request(app).post('/admin/redeliver').send({ event_id: 'evt_nope' }).expect(404);
    await call(...happy.PAN);
    await sched.advance(1_000);
    await request(app).post('/admin/reset').expect(200);
    await request(app).post('/admin/redeliver').send({}).expect(404);
    expect(sent).toHaveLength(1);
  });

  it('outage refuses every verify request with 503 and sends nothing; off again, requests work', async () => {
    makeApp({ outage: true });
    for (const [path, body] of Object.values(happy)) {
      const res = await request(app).post(path).send(body);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('PROVIDER_UNAVAILABLE');
    }
    await sched.advance(5_000);
    expect(sent).toHaveLength(0);
    await request(app).post('/admin/config').send({ outage: false }).expect(200);
    await call(...happy.PAN);
  });

  it('dropCallback sends nothing', async () => {
    makeApp({ dropCallback: true });
    await call(...happy.GST);
    await sched.advance(3_600_000);
    expect(sent).toHaveLength(0);
  });

  it('lateCallbackMs replaces delayMs', async () => {
    makeApp({ lateCallbackMs: 60_000 });
    await call(...happy.RISK);
    await sched.advance(59_999);
    expect(sent).toHaveLength(0);
    await sched.advance(1);
    expect(sent).toHaveLength(1);
  });

  it('settings apply to requests made after the change', async () => {
    await call(...happy.PAN);
    await request(app).post('/admin/config').send({ dropCallback: true });
    await call(...happy.GST);
    await sched.advance(1_000);
    expect(sent.map((s) => s.callback.kind)).toEqual(['PAN']);
  });
});
