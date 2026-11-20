import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationDetailDtoSchema, MERCHANT_ID_RE, type ApplicationDetailDto, type ChaosConfig } from '@app/shared';
import { createManualScheduler, createMockApp, type ManualScheduler } from 'mock-providers';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/client.js';
import { jobs, merchantAccounts } from '../db/schema.js';
import { createJobHandlers } from '../jobs/handlers.js';
import { runDueJobsOnce, type WorkerDeps } from '../jobs/worker.js';
import { createLogger } from '../logger.js';
import { createSimulatedMerchantService } from '../merchant/service.js';
import { createHttpProviderClient } from '../providers/client.js';

/*
 * Phase 5 "Done when", end to end: API + mock providers in-process on random
 * ports, real HTTP both ways, worker driven on a fake clock, mock callbacks on
 * virtual time. The merchant service instance is shared by the API (admin
 * failure flag) and the worker, as in index.ts.
 */

const SECRET = 'phase5-secret';
const SAMPLE_DIR = fileURLToPath(new URL('../../../sample-data/', import.meta.url));
const sample = (name: string) => JSON.parse(readFileSync(join(SAMPLE_DIR, name), 'utf8'));
const T0 = 1_700_000_000_000;
const NEW_ACCT = '60200111122223';

let clock: number;
let db: Db;
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
  const config = loadConfig({ DB_PATH: ':memory:', HMAC_SECRET: SECRET });
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
    handlers: createJobHandlers({ providers: createHttpProviderClient({ baseUrl: mockUrl }), merchantService }),
  };
});
afterEach(async () => {
  await Promise.all([apiServer, mockServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.$client.close();
});

/**
 * Run queued jobs at their run_at (fake clock) that fall due within `horizon`
 * ms: enough for job backoff retries (1s, 2s), not for the 30s verification
 * timeouts, which these tests never want to fire.
 */
async function drain(horizon = 5_000) {
  const until = clock + horizon;
  for (let i = 0; i < 100; i++) {
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
/** Submit and run until the four callbacks are in (VERIFIED, approve job queued but not yet run). */
async function toVerified(body = sample('happy.json')) {
  const id = await submit(body);
  await drain(); // extract, start_verifications (timeouts stay queued 30s out)
  // Only run jobs due now: leave the approve job for the test to decide.
  expect(await deliver()).toBe(4);
  expect((await detail(id)).status).toBe('VERIFIED');
  return id;
}
const review = (id: string, taskId: number, resolution: string, note = 'checked by ops') =>
  api().post(`/applications/${id}/review`).send({ taskId, resolution, note });
const openTask = (d: ApplicationDetailDto, reason: string) => d.review_tasks.find((t) => t.reason === reason && t.status === 'OPEN')!;
const transitions = (d: ApplicationDetailDto) => d.audit_log.filter((a) => a.to_state !== null).map((a) => `${a.to_state} ${a.actor} ${a.event}`);

describe('Phase 5 end to end', () => {
  it('happy.json ends at MERCHANT_CREATED with a MID', async () => {
    const id = await toVerified();
    await drain();
    const d = await detail(id);
    expect(d.status).toBe('MERCHANT_CREATED');
    expect(d.merchant_id).toMatch(MERCHANT_ID_RE);
    expect(transitions(d).slice(-3)).toEqual([
      'VERIFIED system ALL_CHECKS_PASSED',
      'APPROVED system AUTO_APPROVED',
      'MERCHANT_CREATED system MERCHANT_CREATED',
    ]);
    expect(d.review_tasks).toEqual([]);
    expect(db.select().from(merchantAccounts).all()).toHaveLength(1);
  });

  it('forced create failure: retries, MERCHANT_CREATION_FAILED, operator retry, MERCHANT_CREATED', async () => {
    expect((await api().post('/admin/merchant-service').send({ fail: true })).body).toEqual({ fail: true });
    expect((await api().get('/admin/merchant-service')).body).toEqual({ fail: true });
    const id = await toVerified();
    await drain();

    let d = await detail(id);
    expect(d.status).toBe('MERCHANT_CREATION_FAILED');
    expect(d.merchant_id).toBeNull();
    expect(d.audit_log.filter((a) => a.event === 'JOB_FAILED').map((a) => (a.detail as { attempts: number }).attempts)).toEqual([1, 2]);
    const task = openTask(d, 'MERCHANT_CREATION_FAILED');
    expect(task.note).toContain('failed 3 time(s)');

    // APPROVE is not the way out of MERCHANT_CREATION_FAILED; the task stays open.
    const wrong = await review(id, task.id, 'APPROVE');
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.message).toBe('APPROVE is not possible while the application is MERCHANT_CREATION_FAILED');
    expect(openTask(await detail(id), 'MERCHANT_CREATION_FAILED').id).toBe(task.id);

    await api().post('/admin/merchant-service').send({ fail: false }).expect(200);
    const res = await review(id, task.id, 'RETRY_MERCHANT_CREATION', 'service restored, retrying');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    await drain();

    d = await detail(id);
    expect(d.status).toBe('MERCHANT_CREATED');
    expect(d.merchant_id).toMatch(MERCHANT_ID_RE);
    expect(transitions(d).slice(-4)).toEqual([
      'APPROVED system AUTO_APPROVED',
      'MERCHANT_CREATION_FAILED system MERCHANT_CREATION_FAILED',
      'APPROVED operator MERCHANT_CREATION_RETRY',
      'MERCHANT_CREATED system MERCHANT_CREATED',
    ]);
    expect(d.audit_log.find((a) => a.event === 'MERCHANT_CREATION_RETRY')!.detail).toMatchObject({
      task_id: task.id,
      resolution: 'RETRY_MERCHANT_CREATION',
      note: 'service restored, retrying',
    });
    expect(d.review_tasks.find((t) => t.id === task.id)).toMatchObject({
      status: 'RESOLVED',
      resolution: 'RETRY_MERCHANT_CREATION',
      resolution_note: 'service restored, retrying',
    });
    expect(db.select().from(merchantAccounts).all()).toHaveLength(1);
  });

  it('bank change after VERIFIED: approval is 409 until BANK re-verifies, then the app completes', async () => {
    const id = await toVerified();
    // The merchant changes bank details before the approve job runs.
    let res = await api().patch(`/applications/${id}`).send({ bank_account: NEW_ACCT });
    expect(res.status).toBe(200);
    let d = ApplicationDetailDtoSchema.parse(res.body);
    expect(d).toMatchObject({ status: 'VERIFYING', bank_version: 2 });
    expect(transitions(d).slice(-2)).toEqual(['IN_REVIEW merchant BANK_CHANGED', 'VERIFYING system BANK_REVERIFICATION_STARTED']);
    expect(d.audit_log.find((a) => a.event === 'BANK_CHANGED')!.detail).toMatchObject({ bank_version_from: 1, bank_version_to: 2 });
    expect(d.verifications.find((v) => v.kind === 'BANK')).toMatchObject({ bank_version: 1, superseded: true });
    const task = openTask(d, 'BANK_CHANGED');
    expect(JSON.stringify(d)).not.toContain(NEW_ACCT);

    res = await review(id, task.id, 'APPROVE');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('APPROVE is not possible while the application is VERIFYING');

    await drain(); // stale approve job is a no-op; BANK re-requested for version 2
    d = await detail(id);
    expect(d.status).toBe('VERIFYING');
    expect(d.verifications.filter((v) => v.kind === 'BANK').map((v) => [v.bank_version, v.status, v.superseded])).toEqual([
      [1, 'PASSED', true],
      [2, 'PENDING', false],
    ]);
    expect((await review(id, task.id, 'APPROVE')).status).toBe(409);

    expect(await deliver()).toBe(1);
    d = await detail(id);
    expect(d.status).toBe('VERIFIED');
    expect(d.review_tasks.find((t) => t.id === task.id)).toMatchObject({ status: 'RESOLVED', resolution: 'AUTO_REVERIFIED' });

    await drain();
    d = await detail(id);
    expect(d.status).toBe('MERCHANT_CREATED');
    expect(d.merchant_id).toMatch(MERCHANT_ID_RE);
    expect(d.audit_log.filter((a) => a.event === 'AUTO_APPROVED')).toHaveLength(1);
  });

  it('bank change while IN_REVIEW: the approval guard returns 409 until the new BANK check passes', async () => {
    const id = await toVerified(sample('high-risk.json'));
    await drain();
    let d = await detail(id);
    expect(d.status).toBe('IN_REVIEW');
    const task = openTask(d, 'HIGH_RISK');

    await api().patch(`/applications/${id}`).send({ bank_account: NEW_ACCT, ifsc: 'ICIC0009999' }).expect(200);
    d = await detail(id);
    expect(d).toMatchObject({ status: 'IN_REVIEW', bank_version: 2 });
    expect(d.audit_log.at(-1)).toMatchObject({ event: 'BANK_CHANGED', actor: 'merchant', to_state: null, detail: { fields: ['bank_account', 'ifsc'] } });

    let res = await review(id, task.id, 'APPROVE');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'GUARD_FAILED',
      message: 'Cannot approve: BANK is not started for bank version 2. All of PAN, GST, BANK, RISK must pass first.',
    });

    await drain(); // BANK re-requested even though the app is IN_REVIEW
    res = await review(id, task.id, 'APPROVE');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('BANK is pending for bank version 2');
    expect(openTask(await detail(id), 'HIGH_RISK').id).toBe(task.id); // rolled back: still OPEN

    expect(await deliver()).toBe(1);
    expect((await detail(id)).status).toBe('IN_REVIEW'); // callbacks in review do not move it

    res = await review(id, task.id, 'APPROVE', 'risk accepted after call');
    expect(res.status).toBe(200);
    await drain();
    d = await detail(id);
    expect(d.status).toBe('MERCHANT_CREATED');
    expect(transitions(d).slice(-2)).toEqual(['APPROVED operator OPERATOR_APPROVED', 'MERCHANT_CREATED system MERCHANT_CREATED']);
  });

  it('a callback for the old bank_version after a change is recorded as stale and ignored', async () => {
    await setChaos({ delayMs: 5_000 });
    const id = await submit(sample('happy.json'));
    await drain();
    await deliver(1_000); // nothing yet
    await api().patch(`/applications/${id}`).send({ bank_account: NEW_ACCT }).expect(200);
    await drain();
    await deliver(5_000); // all four v1 answers (BANK v1 is stale) + BANK v2
    const d = await detail(id);
    expect(d.audit_log.filter((a) => a.event === 'STALE_CALLBACK').map((a) => (a.detail as { kind: string }).kind)).toEqual(['BANK']);
    expect(d.status).toBe('VERIFIED');
  });

  it('high risk goes to IN_REVIEW HIGH_RISK, never auto-approved', async () => {
    const id = await toVerified(sample('high-risk.json'));
    await drain();
    const d = await detail(id);
    expect(d.status).toBe('IN_REVIEW');
    expect(d.verifications.find((v) => v.kind === 'RISK')!.score).toBe(85);
    expect(transitions(d).at(-1)).toBe('IN_REVIEW system HIGH_RISK');
    expect(openTask(d, 'HIGH_RISK').note).toBe('Risk score 85 is above the auto-approval threshold of 70');
    expect(d.merchant_id).toBeNull();
  });
});

describe('POST /applications/:id/review', () => {
  async function highRiskTask() {
    const id = await toVerified(sample('high-risk.json'));
    await drain();
    return { id, task: openTask(await detail(id), 'HIGH_RISK') };
  }

  it('validates the body: resolution enum, note required (min 5 chars), taskId', async () => {
    const { id, task } = await highRiskTask();
    for (const body of [
      { taskId: task.id, resolution: 'APPROVE' },
      { taskId: task.id, resolution: 'APPROVE', note: '  ok  ' },
      { taskId: task.id, resolution: 'MAYBE', note: 'looks fine' },
      { resolution: 'APPROVE', note: 'looks fine' },
    ]) {
      expect((await api().post(`/applications/${id}/review`).send(body)).status).toBe(400);
    }
    expect((await detail(id)).status).toBe('IN_REVIEW');
  });

  it('404 for an unknown app or a task of another app; 409 for a resolved task', async () => {
    const { id, task } = await highRiskTask();
    expect((await review('nope', task.id, 'REJECT')).status).toBe(404);
    expect((await review(id, 9999, 'REJECT')).status).toBe(404);
    expect((await review(id, task.id, 'REJECT', 'fraud signals')).status).toBe(200);
    const again = await review(id, task.id, 'APPROVE');
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe(`Review task ${task.id} is already resolved (REJECT)`);
  });

  it('REJECT: IN_REVIEW -> REJECTED, actor operator, note audited and stored on the task', async () => {
    const { id, task } = await highRiskTask();
    const res = await review(id, task.id, 'REJECT', 'Merchant on internal watchlist');
    expect(res.body.status).toBe('REJECTED');
    const d = ApplicationDetailDtoSchema.parse(res.body);
    expect(d.audit_log.at(-1)).toMatchObject({
      actor: 'operator',
      from_state: 'IN_REVIEW',
      to_state: 'REJECTED',
      event: 'OPERATOR_REJECTED',
      detail: { task_id: task.id, task_reason: 'HIGH_RISK', resolution: 'REJECT', note: 'Merchant on internal watchlist' },
    });
    expect(d.review_tasks[0]).toMatchObject({ status: 'RESOLVED', resolution: 'REJECT', resolution_note: 'Merchant on internal watchlist' });
  });

  it('REQUEST_INFO: IN_REVIEW -> NEEDS_INFO', async () => {
    const { id, task } = await highRiskTask();
    const res = await review(id, task.id, 'REQUEST_INFO', 'Need audited financials');
    expect(res.body.status).toBe('NEEDS_INFO');
    expect(res.body.audit_log.at(-1)).toMatchObject({ event: 'OPERATOR_REQUESTED_INFO', actor: 'operator' });
  });

  it('masks a PAN typed into the note', async () => {
    const { id, task } = await highRiskTask();
    const res = await review(id, task.id, 'REJECT', 'PAN AABCR5678M is blacklisted');
    expect(res.text).not.toContain('AABCR5678M');
  });

  it('RETRY_VERIFICATION re-runs only the failed check, which then passes', async () => {
    await setChaos({ failKinds: ['GST'] });
    const id = await submit(sample('happy.json'));
    await drain();
    await deliver();
    let d = await detail(id);
    expect(d.status).toBe('IN_REVIEW');
    const task = openTask(d, 'PAN_OK_GST_FAILED');

    await setChaos({ failKinds: [] });
    const res = await review(id, task.id, 'RETRY_VERIFICATION', 'GST portal was down');
    expect(res.body.status).toBe('VERIFYING');
    expect(res.body.audit_log.at(-1)).toMatchObject({ event: 'OPERATOR_REVERIFY', detail: { kinds: ['GST'] } });
    await drain();
    expect(await deliver()).toBe(1);
    await drain();
    d = await detail(id);
    expect(d.status).toBe('MERCHANT_CREATED');
    expect(d.verifications.filter((v) => v.kind === 'GST').map((v) => [v.attempt, v.status, v.superseded])).toEqual([
      [1, 'FAILED', true],
      [1, 'PASSED', false],
    ]);
  });

  it('RETRY_MERCHANT_CREATION outside MERCHANT_CREATION_FAILED is a readable 409', async () => {
    const { id, task } = await highRiskTask();
    const res = await review(id, task.id, 'RETRY_MERCHANT_CREATION');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'ILLEGAL_TRANSITION',
      message: 'RETRY_MERCHANT_CREATION is not possible while the application is IN_REVIEW',
    });
  });

  it('/admin/merchant-service validates its body', async () => {
    expect((await api().post('/admin/merchant-service').send({ fail: 'yes' })).status).toBe(400);
    expect((await api().post('/admin/merchant-service').send({})).status).toBe(400);
  });
});
