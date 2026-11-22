import type { ProviderCallback } from '@app/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Db } from '../db/client.js';
import { callbackEvents } from '../db/schema.js';
import { auditOf, makeEnv, T0, verifyingApp } from '../verification/testkit.js';
import { signBody, verifySignature } from './signature.js';

const SECRET = 'test-secret';
let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const env = makeEnv();
  db = env.db;
  app = createApp({ ...env, now: () => T0 });
});
afterEach(() => db.$client.close());

const callback = (over: Partial<ProviderCallback> = {}): ProviderCallback => ({
  event_id: 'evt-1',
  request_id: 'req-1',
  kind: 'PAN',
  result: { status: 'PASSED' },
  application_ref: 'app-1',
  ...over,
});

function post(raw: string, signature: string | null = signBody(SECRET, raw)) {
  const req = request(app).post('/webhooks/provider').set('content-type', 'application/json');
  if (signature !== null) req.set('x-signature', signature);
  return req.send(raw);
}

const events = () => db.select().from(callbackEvents).orderBy(callbackEvents.id).all();

describe('verifySignature', () => {
  const body = Buffer.from('{"a":1}');
  it('accepts the exact HMAC (with or without a sha256= prefix) and nothing else', () => {
    const sig = signBody(SECRET, body);
    expect(verifySignature(SECRET, body, sig)).toBe(true);
    expect(verifySignature(SECRET, body, `sha256=${sig}`)).toBe(true);
    expect(verifySignature(SECRET, body, sig.toUpperCase())).toBe(true);
    expect(verifySignature('other', body, sig)).toBe(false);
    expect(verifySignature(SECRET, Buffer.from('{"a":2}'), sig)).toBe(false);
    for (const bad of [undefined, '', 'zz', sig.slice(0, 62), `${sig}00`, 'g'.repeat(64)]) {
      expect(verifySignature(SECRET, body, bad)).toBe(false);
    }
  });
});

describe('POST /webhooks/provider', () => {
  it('stores a correctly signed callback and answers 200', async () => {
    verifyingApp(db);
    const raw = JSON.stringify(callback());
    const res = await post(raw);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'accepted', event_id: 'evt-1' });
    expect(events()).toMatchObject([
      { eventId: 'evt-1', applicationId: 'app-1', kind: 'PAN', requestId: 'req-1', isDuplicate: false, receivedAt: T0 },
    ]);
  });

  it('verifies the raw bytes (whitespace and key order are preserved)', async () => {
    const raw = `{ "kind":"GST",  "event_id":"evt-2","request_id":"r","result":{"status":"FAILED"},"application_ref":"x" }\n`;
    expect((await post(raw)).status).toBe(200);
    expect(events()).toHaveLength(1);
  });

  it.each([
    ['a wrong signature', (raw: string) => post(raw, signBody('wrong-secret', raw))],
    ['a missing signature', (raw: string) => post(raw, null)],
    ['a garbage signature', (raw: string) => post(raw, 'not-hex')],
    ['a tampered body', (raw: string) => post(raw.replace('PASSED', 'FAILED'), signBody(SECRET, raw))],
  ])('rejects %s with 401 and stores nothing', async (_label, send) => {
    verifyingApp(db);
    const auditBefore = auditOf(db).length;
    const res = await send(JSON.stringify(callback()));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('BAD_SIGNATURE');
    expect(events()).toEqual([]);
    expect(auditOf(db)).toHaveLength(auditBefore);
  });

  it('a duplicate event_id answers 200 and adds one is_duplicate row, nothing else', async () => {
    const raw = JSON.stringify(callback());
    expect((await post(raw)).body.status).toBe('accepted');
    const second = await post(raw);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: 'duplicate', event_id: 'evt-1' });
    expect(events().map((e) => [e.eventId, e.isDuplicate, e.note])).toEqual([
      ['evt-1', false, expect.not.stringContaining('duplicate')],
      ['evt-1', true, 'duplicate ignored'],
    ]);
    // A third delivery is just another duplicate row.
    await post(raw);
    expect(events().filter((e) => e.isDuplicate)).toHaveLength(2);
  });

  it('a signed but malformed body is a 400 and is not stored', async () => {
    expect((await post('{not json')).status).toBe(400);
    const res = await post(JSON.stringify({ ...callback(), kind: 'FOO' }));
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([{ path: 'kind', code: 'invalid_value' }]);
    expect(events()).toEqual([]);
  });

  it('other routes still parse JSON normally', async () => {
    const res = await request(app).post('/applications').send({ merchant_name: 'Sunrise Bakery' });
    expect(res.status).toBe(201);
  });
});
