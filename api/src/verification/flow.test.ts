import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationDetailDtoSchema, type ApplicationDetailDto, type ChaosConfig } from '@app/shared';
import { createManualScheduler, createMockApp, type ManualScheduler, type MockApp } from 'mock-providers';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/client.js';
import { auditLog, callbackEvents, jobs, verifications } from '../db/schema.js';
import { signBody } from '../http/signature.js';
import { createJobHandlers } from '../jobs/handlers.js';
import { runDueJobsOnce, type WorkerDeps } from '../jobs/worker.js';
import { createLogger } from '../logger.js';
import { createHttpProviderClient } from '../providers/client.js';

/*
 * Phase 4 "Done when": the API and the mock providers both run in-process on
 * random ports and talk over real HTTP (provider requests one way, signed
 * callbacks the other). The API worker is driven with runDueJobsOnce on a
 * fake clock; the mock's callbacks run on a manual (virtual-time) scheduler.
 * No sleeps.
 */

const SECRET = 'flow-test-secret';
const SAMPLE_DIR = fileURLToPath(new URL('../../../sample-data/', import.meta.url));
const sample = (name: string) => JSON.parse(readFileSync(join(SAMPLE_DIR, name), 'utf8'));
const T0 = 1_700_000_000_000;
const TIMEOUT = 30_000;

let clock: number;
let db: Db;
let apiServer: Server;
let mockServer: Server;
let mock: MockApp;
let sched: ManualScheduler;
let worker: WorkerDeps;
let apiUrl: string;
let deliveries: { status?: number; error?: string }[];

async function listen(app: { listen: (port: number) => Server }): Promise<[Server, string]> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  return [server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`];
}

async function setup(mockSecret = SECRET, chaos: Partial<ChaosConfig> = {}) {
  clock = T0;
  db = openDb(':memory:');
  const config = loadConfig({ DB_PATH: ':memory:', HMAC_SECRET: SECRET });
  const logger = createLogger({ level: 'silent' });
  [apiServer, apiUrl] = await listen(createApp({ config, logger, db, now: () => clock }));

  sched = createManualScheduler();
  deliveries = [];
  mock = createMockApp({
    webhookUrl: `${apiUrl}/webhooks/provider`,
    hmacSecret: mockSecret,
    scheduler: sched,
    chaos: { delayMs: 1_000, ...chaos },
    onDelivery: (d) => deliveries.push(d),
  });
  let mockUrl: string;
  [mockServer, mockUrl] = await listen(mock);
  worker = { db, config, logger, handlers: createJobHandlers({ providers: createHttpProviderClient({ baseUrl: mockUrl }) }) };
}

beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  await Promise.all([apiServer, mockServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.$client.close();
});

/** Run API worker ticks, 1s of fake time apart, until nothing is due. */
async function drain(maxTicks = 30) {
  for (let i = 0; i < maxTicks; i++) {
    clock += 1_000;
    if ((await runDueJobsOnce(worker, clock)).claimed === 0) return;
  }
  throw new Error('worker did not go idle');
}

/** Move the API clock forward by `ms`, running every job that falls due on the way, at its run_at. */
async function advance(ms: number) {
  const target = clock + ms;
  for (;;) {
    const next = db
      .select()
      .from(jobs)
      .all()
      .filter((j) => j.status === 'queued' && j.runAt <= target)
      .sort((a, b) => a.runAt - b.runAt)[0];
    if (!next) break;
    clock = Math.max(clock, next.runAt);
    await runDueJobsOnce(worker, clock);
  }
  clock = target;
}

/** Move the mock's virtual time: sends (and awaits) every callback due by then. */
const deliver = (ms: number) => sched.advance(ms);

async function submit(body: unknown): Promise<string> {
  const res = await request(apiServer).post('/applications').send(body as object);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function detail(id: string): Promise<ApplicationDetailDto> {
  const res = await request(apiServer).get(`/applications/${id}`);
  expect(res.status).toBe(200);
  return ApplicationDetailDtoSchema.parse(res.body);
}

const transitions = (d: ApplicationDetailDto) => d.audit_log.filter((a) => a.to_state !== null).map((a) => `${a.to_state} ${a.event}`);
const events = (d: ApplicationDetailDto, name: string) => d.audit_log.filter((a) => a.event === name);
const callbackRows = () => db.select().from(callbackEvents).orderBy(callbackEvents.id).all();
const setChaos = (patch: Partial<ChaosConfig>) => request(mock).post('/admin/config').send(patch).expect(200);

describe('verification with the mock providers', () => {
  it('happy.json: four signed callbacks -> VERIFIED', async () => {
    const id = await submit(sample('happy.json'));
    await drain();
    let d = await detail(id);
    expect(d.status).toBe('VERIFYING');
    expect(d.verifications.map((v) => [v.kind, v.status, v.attempt])).toEqual([
      ['PAN', 'PENDING', 1],
      ['GST', 'PENDING', 1],
      ['BANK', 'PENDING', 1],
      ['RISK', 'PENDING', 1],
    ]);

    expect(await deliver(1_000)).toBe(4);
    expect(deliveries.map((x) => x.status)).toEqual([200, 200, 200, 200]);

    d = await detail(id);
    expect(d.status).toBe('VERIFIED');
    expect(d.verifications.every((v) => v.status === 'PASSED' && v.completed_at !== null)).toBe(true);
    expect(d.verifications.find((v) => v.kind === 'RISK')!.score).toEqual(expect.any(Number));
    expect(transitions(d)).toEqual([
      'SUBMITTED APPLICATION_SUBMITTED',
      'EXTRACTING EXTRACTION_STARTED',
      'VERIFYING VERIFICATION_STARTED',
      'VERIFIED ALL_CHECKS_PASSED',
    ]);
    expect(events(d, 'VERIFICATION_REQUESTED')).toHaveLength(4);
    expect(events(d, 'VERIFICATION_RESULT').map((a) => a.actor)).toEqual(['provider', 'provider', 'provider', 'provider']);
    expect(callbackRows().map((e) => [e.isDuplicate, e.processed, e.note])).toEqual(Array(4).fill([false, true, 'applied']));
    expect(d.review_tasks).toEqual([]);
    // No raw PAN, GSTIN or account number anywhere in the response.
    expect(JSON.stringify(d)).not.toMatch(/AABCL1234K|50100234567891/);

    // Later timeouts find nothing pending; the approve job (Phase 5 stub) runs.
    clock += TIMEOUT;
    await drain();
    d = await detail(id);
    expect(d.status).toBe('VERIFIED');
    expect(events(d, 'VERIFICATION_TIMED_OUT')).toEqual([]);
    expect(db.select().from(jobs).all().every((j) => j.status === 'done')).toBe(true);
  });

  it('duplicate callbacks: exactly one effect per event and one is_duplicate row each', async () => {
    await setChaos({ duplicateCallback: true });
    const id = await submit(sample('happy.json'));
    await drain();
    await deliver(1_000);
    expect(deliveries).toHaveLength(8);
    expect(deliveries.every((x) => x.status === 200)).toBe(true);

    const rows = callbackRows();
    expect(rows).toHaveLength(8);
    const byEvent = new Map<string, typeof rows>();
    for (const r of rows) byEvent.set(r.eventId, [...(byEvent.get(r.eventId) ?? []), r]);
    expect(byEvent.size).toBe(4);
    for (const group of byEvent.values()) {
      expect(group.map((r) => [r.isDuplicate, r.processed, r.note])).toEqual([
        [false, true, 'applied'],
        [true, false, 'duplicate ignored'],
      ]);
    }

    const d = await detail(id);
    expect(d.status).toBe('VERIFIED');
    expect(events(d, 'VERIFICATION_RESULT')).toHaveLength(4);
    expect(events(d, 'ALL_CHECKS_PASSED')).toHaveLength(1);
    expect(d.verifications).toHaveLength(4);
    expect(db.select().from(jobs).all().filter((j) => j.type === 'approve')).toHaveLength(1);
  });

  it('gst-fail.json: PAN passes, GST fails -> IN_REVIEW with PAN_OK_GST_FAILED', async () => {
    const id = await submit(sample('gst-fail.json'));
    await drain();
    await deliver(1_000);

    const d = await detail(id);
    expect(d.status).toBe('IN_REVIEW');
    expect(d.review_tasks).toHaveLength(1);
    expect(d.review_tasks[0]).toMatchObject({ reason: 'PAN_OK_GST_FAILED', status: 'OPEN' });
    expect(d.review_tasks[0]!.note).toContain('GST: failed (GSTIN_INACTIVE)');
    expect(transitions(d).at(-1)).toBe('IN_REVIEW VERIFICATION_FAILED');
    // BANK and RISK still arrive and are recorded, without moving the application.
    expect(d.verifications.map((v) => [v.kind, v.status])).toEqual([
      ['PAN', 'PASSED'],
      ['GST', 'FAILED'],
      ['BANK', 'PASSED'],
      ['RISK', 'PASSED'],
    ]);
    expect(events(d, 'VERIFICATION_RESULT').slice(-2).map((a) => a.from_state)).toEqual(['IN_REVIEW', 'IN_REVIEW']);
  });

  it('late callbacks after a timeout are recorded, audited LATE_CALLBACK and reconciled to VERIFIED', async () => {
    // First requests answer after 60s (the API times out at 30s); retries never answer.
    await setChaos({ lateCallbackMs: 60_000 });
    const id = await submit(sample('happy.json'));
    await drain();
    await setChaos({ lateCallbackMs: 0, dropCallback: true });

    clock += TIMEOUT;
    await drain(); // timeouts fire, then the retries (attempt 2) are requested after 1s backoff
    let d = await detail(id);
    expect(d.status).toBe('VERIFYING');
    expect(events(d, 'VERIFICATION_TIMED_OUT')).toHaveLength(4);
    expect(d.verifications.map((v) => [v.kind, v.attempt, v.status])).toEqual([
      ['PAN', 1, 'TIMED_OUT'],
      ['GST', 1, 'TIMED_OUT'],
      ['BANK', 1, 'TIMED_OUT'],
      ['RISK', 1, 'TIMED_OUT'],
      ['PAN', 2, 'PENDING'],
      ['GST', 2, 'PENDING'],
      ['BANK', 2, 'PENDING'],
      ['RISK', 2, 'PENDING'],
    ]);

    expect(await deliver(60_000)).toBe(4); // the late answers to attempt 1

    d = await detail(id);
    expect(d.status).toBe('VERIFIED');
    const late = events(d, 'LATE_CALLBACK');
    expect(late).toHaveLength(4);
    expect(late[0]).toMatchObject({ actor: 'provider', to_state: null, detail: { kind: 'PAN', attempt: 1, status: 'PASSED', superseded_attempts: [2] } });
    expect(d.verifications.map((v) => [v.attempt, v.status, v.superseded])).toEqual([
      ...Array(4).fill([1, 'PASSED', false]),
      ...Array(4).fill([2, 'PENDING', true]),
    ]);
    expect(callbackRows().map((e) => e.note)).toEqual(Array(4).fill('late'));

    // The retries' timeouts find superseded rows: nothing escalates.
    clock += TIMEOUT;
    await drain();
    d = await detail(id);
    expect(d.status).toBe('VERIFIED');
    expect(d.review_tasks).toEqual([]);
    expect(events(d, 'VERIFICATION_TIMED_OUT')).toHaveLength(4);
  });

  it('bank account ending 0000: never answered, retried twice, then IN_REVIEW with BANK_TIMEOUT', async () => {
    const body = sample('happy.json');
    body.bank_account = '50100234560000';
    body.documents[2].payload.account_number = '50100234560000';
    const id = await submit(body);
    await drain();
    await deliver(1_000); // PAN, GST, RISK answer; BANK never does
    // 3 attempts x 30s timeout, plus 1s and 2s backoff before the retries.
    await advance(3 * TIMEOUT + 3_000);
    const d = await detail(id);
    expect(d.status).toBe('IN_REVIEW');
    expect(d.review_tasks.map((t) => t.reason)).toEqual(['BANK_TIMEOUT']);
    expect(d.verifications.filter((v) => v.kind === 'BANK').map((v) => [v.attempt, v.status])).toEqual([
      [1, 'TIMED_OUT'],
      [2, 'TIMED_OUT'],
      [3, 'TIMED_OUT'],
    ]);
    const bank = d.verifications.filter((v) => v.kind === 'BANK').map((v) => Date.parse(v.requested_at));
    expect([bank[1]! - bank[0]!, bank[2]! - bank[1]!]).toEqual([TIMEOUT + 1_000, TIMEOUT + 2_000]);
    // Escalated exactly when attempt 3 timed out.
    expect(Date.parse(d.audit_log.at(-1)!.at)).toBe(bank[2]! + TIMEOUT);
    expect(d.audit_log.at(-1)).toMatchObject({ event: 'VERIFICATION_TIMED_OUT', to_state: 'IN_REVIEW' });
  });
});

describe('webhook signature end to end', () => {
  it('a bad signature is rejected with 401 and nothing is stored', async () => {
    const id = await submit(sample('happy.json'));
    await drain();
    const [pan] = db.select().from(verifications).all();
    const auditBefore = db.select().from(auditLog).all().length;
    const body = JSON.stringify({
      event_id: 'forged',
      request_id: pan!.requestId,
      kind: 'PAN',
      result: { status: 'PASSED' },
      application_ref: id,
    });
    const res = await fetch(`${apiUrl}/webhooks/provider`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': signBody('not-the-secret', body) },
      body,
    });
    expect(res.status).toBe(401);
    expect(callbackRows()).toEqual([]);
    expect(db.select().from(auditLog).all()).toHaveLength(auditBefore);
    expect(db.select().from(verifications).all().every((v) => v.status === 'PENDING')).toBe(true);
  });

  it('a provider signing with the wrong secret gets 401s and changes nothing', async () => {
    await new Promise<void>((r) => apiServer.close(() => r()));
    await new Promise<void>((r) => mockServer.close(() => r()));
    db.$client.close();
    await setup('wrong-secret');

    const id = await submit(sample('happy.json'));
    await drain();
    await deliver(1_000);
    expect(deliveries.map((x) => x.status)).toEqual([401, 401, 401, 401]);
    expect(callbackRows()).toEqual([]);
    expect((await detail(id)).status).toBe('VERIFYING');
  });
});
