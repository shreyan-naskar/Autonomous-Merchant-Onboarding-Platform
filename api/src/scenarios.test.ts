import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationDetailDtoSchema, MERCHANT_ID_RE, type ApplicationDetailDto, type ChaosConfig } from '@app/shared';
import { createManualScheduler, createMockApp, type ManualScheduler } from 'mock-providers';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { openDb, type Db } from './db/client.js';
import { callbackEvents, jobs } from './db/schema.js';
import { fakeOcr } from './extraction/testkit.js';
import { createJobHandlers } from './jobs/handlers.js';
import { runDueJobsOnce, type WorkerDeps } from './jobs/worker.js';
import { createLogger } from './logger.js';
import { createSimulatedMerchantService } from './merchant/service.js';
import { createHttpProviderClient } from './providers/client.js';

/*
 * The failure scenarios from the brief (docs/PROBLEM.md), one test each,
 * end to end: API + mock providers in-process on random ports, real HTTP and
 * signed callbacks both ways, the worker on a fake clock, callbacks on
 * virtual time. Listed in README.md ("Failure scenarios"). Each scenario is
 * also covered in more detail by the phase test files.
 */

const SECRET = 'scenario-secret';
const SAMPLE_DIR = fileURLToPath(new URL('../../sample-data/', import.meta.url));
const sample = (name: string) => JSON.parse(readFileSync(join(SAMPLE_DIR, name), 'utf8'));
const T0 = 1_700_000_000_000;

let clock: number;
let db: Db;
let config: Config;
let uploadDir: string;
let apiServer: Server;
let mockServer: Server;
let mockUrl: string;
let sched: ManualScheduler;
let worker: WorkerDeps;

async function listen(app: { listen: (port: number) => Server }): Promise<[Server, string]> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  return [server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`];
}

beforeEach(async () => {
  clock = T0;
  db = openDb(':memory:');
  uploadDir = mkdtempSync(join(tmpdir(), 'scenario-uploads-'));
  config = loadConfig({ DB_PATH: ':memory:', HMAC_SECRET: SECRET, UPLOAD_DIR: uploadDir });
  const logger = createLogger({ level: 'silent' });
  const merchantService = createSimulatedMerchantService(db);
  let apiUrl: string;
  [apiServer, apiUrl] = await listen(createApp({ config, logger, db, now: () => clock, merchantService }));
  sched = createManualScheduler();
  const mock = createMockApp({ webhookUrl: `${apiUrl}/webhooks/provider`, hmacSecret: SECRET, scheduler: sched, chaos: { delayMs: 1_000 } });
  [mockServer, mockUrl] = await listen(mock);
  worker = {
    db,
    config,
    logger,
    handlers: createJobHandlers({ providers: createHttpProviderClient({ baseUrl: mockUrl }), merchantService, ocr: fakeOcr() }),
  };
});
afterEach(async () => {
  await Promise.all([apiServer, mockServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.$client.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

/** Run queued jobs at their run_at that fall due within `horizon` ms of now. */
async function drain(horizon = 5_000) {
  const until = clock + horizon;
  for (let i = 0; i < 200; i++) {
    const next = db
      .select()
      .from(jobs)
      .all()
      .filter((j) => j.status === 'queued' && j.runAt <= until)
      .sort((a, b) => a.runAt - b.runAt)[0];
    if (!next) return;
    clock = Math.max(clock + 1, next.runAt);
    await runDueJobsOnce(worker, clock);
  }
  throw new Error('worker did not go idle');
}
const deliver = (ms = 1_000) => sched.advance(ms);
const setChaos = (patch: Partial<ChaosConfig>) => request(mockUrl).post('/admin/config').send(patch).expect(200);
const api = () => request(apiServer);

async function submit(body: unknown): Promise<string> {
  const res = await api().post('/applications').send(body as object);
  expect(res.status).toBe(201);
  return res.body.id as string;
}
async function detail(id: string): Promise<ApplicationDetailDto> {
  const res = await api().get(`/applications/${id}`);
  expect(res.status).toBe(200);
  return ApplicationDetailDtoSchema.parse(res.body);
}
const review = (id: string, taskId: number, resolution: string, note = 'checked by ops') =>
  api().post(`/applications/${id}/review`).send({ taskId, resolution, note });
const openTask = (d: ApplicationDetailDto, reason: string) => d.review_tasks.find((t) => t.reason === reason && t.status === 'OPEN')!;
const events = (d: ApplicationDetailDto, event: string) => d.audit_log.filter((a) => a.event === event);
const states = (d: ApplicationDetailDto) => d.audit_log.filter((a) => a.to_state !== null).map((a) => a.to_state);

describe('brief failure scenarios', () => {
  it('SCENARIO 1 - PAN passes, GST fails: IN_REVIEW with reason PAN_OK_GST_FAILED, no approval', async () => {
    const id = await submit(sample('gst-fail.json'));
    await drain();
    expect(await deliver()).toBe(4);
    await drain();

    const d = await detail(id);
    expect(d.status).toBe('IN_REVIEW');
    expect(d.verifications.map((v) => [v.kind, v.status])).toEqual([
      ['PAN', 'PASSED'],
      ['GST', 'FAILED'],
      ['BANK', 'PASSED'],
      ['RISK', 'PASSED'],
    ]);
    expect(openTask(d, 'PAN_OK_GST_FAILED')).toBeDefined();
    expect(events(d, 'VERIFICATION_FAILED')).toHaveLength(1);
    expect(d.merchant_id).toBeNull();
  });

  it('SCENARIO 2 - duplicate callback: second delivery stored as a duplicate and ignored (one effect per event)', async () => {
    await setChaos({ duplicateCallback: true });
    const id = await submit(sample('happy.json'));
    await drain();
    await deliver(); // the mock sends every callback twice

    const rows = db.select().from(callbackEvents).all();
    expect(rows).toHaveLength(8);
    expect(rows.filter((r) => r.isDuplicate)).toHaveLength(4);
    expect(rows.filter((r) => r.isDuplicate).every((r) => r.note === 'duplicate ignored' && !r.processed)).toBe(true);
    const d = await detail(id);
    expect(d.status).toBe('VERIFIED');
    expect(events(d, 'VERIFICATION_RESULT')).toHaveLength(4);
    expect(events(d, 'ALL_CHECKS_PASSED')).toHaveLength(1);

    await drain();
    expect((await detail(id)).status).toBe('MERCHANT_CREATED');
  });

  it('SCENARIO 3 - late callback after timeout: recorded as LATE_CALLBACK and reconciled, not lost', async () => {
    // Providers answer after 60s; the API times out at 30s and re-requests; the retries never answer.
    await setChaos({ lateCallbackMs: 60_000 });
    const id = await submit(sample('happy.json'));
    await drain();
    await setChaos({ lateCallbackMs: 0, dropCallback: true });

    clock += config.timings.verificationTimeoutMs;
    await drain();
    let d = await detail(id);
    expect(d.status).toBe('VERIFYING');
    expect(events(d, 'VERIFICATION_TIMED_OUT')).toHaveLength(4);

    expect(await deliver(60_000)).toBe(4); // the late answers to attempt 1
    d = await detail(id);
    expect(events(d, 'LATE_CALLBACK')).toHaveLength(4);
    expect(d.status).toBe('VERIFIED');

    await drain();
    expect((await detail(id)).status).toBe('MERCHANT_CREATED');
  });

  it('SCENARIO 4 - bank details changed after verification: approval blocked (409) until the new account is verified', async () => {
    // high-risk.json stays in IN_REVIEW after VERIFIED, so the operator can try to approve.
    const id = await submit(sample('high-risk.json'));
    await drain();
    await deliver();
    await drain();
    let d = await detail(id);
    expect(d.status).toBe('IN_REVIEW');
    const task = openTask(d, 'HIGH_RISK');

    await api().patch(`/applications/${id}`).send({ bank_account: '60200111122223' }).expect(200);
    d = await detail(id);
    expect(d.bank_version).toBe(2);
    expect(d.verifications.find((v) => v.kind === 'BANK' && v.bank_version === 1)).toMatchObject({ superseded: true });

    const blocked = await review(id, task.id, 'APPROVE');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('GUARD_FAILED');
    expect(blocked.body.error.message).toContain('BANK');

    await drain(); // BANK re-requested for bank_version 2
    expect(await deliver()).toBe(1);
    expect((await review(id, task.id, 'APPROVE', 'new account verified')).status).toBe(200);
    await drain();
    expect((await detail(id)).status).toBe('MERCHANT_CREATED');
  });

  it('SCENARIO 5 - approval OK but merchant ID creation fails: retries, MERCHANT_CREATION_FAILED, operator retry succeeds', async () => {
    await api().post('/admin/merchant-service').send({ fail: true }).expect(200);
    const id = await submit(sample('happy.json'));
    await drain();
    await deliver();
    await drain();

    let d = await detail(id);
    expect(d.status).toBe('MERCHANT_CREATION_FAILED');
    expect(states(d)).toContain('APPROVED');
    expect(d.merchant_id).toBeNull();
    expect(events(d, 'JOB_FAILED')).toHaveLength(2);
    const task = openTask(d, 'MERCHANT_CREATION_FAILED');

    await api().post('/admin/merchant-service').send({ fail: false }).expect(200);
    expect((await review(id, task.id, 'RETRY_MERCHANT_CREATION', 'service restored')).status).toBe(200);
    await drain();
    d = await detail(id);
    expect(d.status).toBe('MERCHANT_CREATED');
    expect(d.merchant_id).toMatch(MERCHANT_ID_RE);
  });

  it('SCENARIO 6a - conflicting document: PAN card name differs from the form -> IN_REVIEW DOC_CONFLICT, no verification', async () => {
    const id = await submit(sample('conflict.json'));
    await drain();
    const d = await detail(id);
    expect(d.status).toBe('IN_REVIEW');
    expect(openTask(d, 'DOC_CONFLICT').note).toContain('PAN_CARD.name (name_mismatch');
    expect(d.verifications).toEqual([]);
  });

  it('SCENARIO 6b - blurred document image: blur score below threshold -> IN_REVIEW BLURRY_DOCUMENT, no OCR', async () => {
    const form = sample('ocr-pan.json');
    const res = await api()
      .post('/applications')
      .field('merchant_name', form.merchant_name)
      .field('pan', form.pan)
      .field('gst', form.gst)
      .field('bank_account', form.bank_account)
      .field('ifsc', form.ifsc)
      .field('documents', JSON.stringify(form.documents))
      .attach('PAN_CARD', readFileSync(join(SAMPLE_DIR, 'pan-blurry.png')), { filename: 'pan.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    await drain();

    const d = await detail(res.body.id);
    expect(d.status).toBe('IN_REVIEW');
    expect(d.documents.find((x) => x.type === 'PAN_CARD')!.blur_score).toBeLessThan(config.thresholds.blur);
    expect(openTask(d, 'BLURRY_DOCUMENT')).toBeDefined();
    expect(d.verifications).toEqual([]);
  });
});
