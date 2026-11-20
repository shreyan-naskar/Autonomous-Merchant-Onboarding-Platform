import { MERCHANT_ID_RE } from '@app/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import { applications, jobs, merchantAccounts } from '../db/schema.js';
import { transition } from '../domain/transition.js';
import { enqueueJob } from '../jobs/queue.js';
import { createJobHandlers } from '../jobs/handlers.js';
import { runDueJobsOnce, type WorkerDeps } from '../jobs/worker.js';
import { createFakeProviderClient } from '../providers/fake.js';
import { appRow, auditOf, jobsOfType, makeEnv, T0, tasksOf, verifiedApp } from '../verification/testkit.js';
import { createSimulatedMerchantService, generateMerchantId, type SimulatedMerchantService } from './service.js';

let env: ReturnType<typeof makeEnv>;
let db: Db;
let service: SimulatedMerchantService;
let worker: WorkerDeps;
let clock: number;

beforeEach(() => {
  env = makeEnv();
  db = env.db;
  service = createSimulatedMerchantService(db);
  worker = { ...env, handlers: createJobHandlers({ providers: createFakeProviderClient(), merchantService: service }) };
  clock = T0;
});
afterEach(() => db.$client.close());

/** An APPROVED application with its create_merchant job queued (as approve would leave it). */
function approvedApp(id = 'app-1') {
  verifiedApp(db, id);
  transition(db, id, 'APPROVED', { actor: 'system', event: 'AUTO_APPROVED', now: T0 });
  enqueueJob(db, 'create_merchant', { application_id: id }, { now: T0, maxAttempts: env.config.limits.merchantCreateMaxAttempts });
}

/** Run jobs at their run_at until nothing is queued. */
async function drain() {
  for (let i = 0; i < 50; i++) {
    const next = db.select().from(jobs).where(eq(jobs.status, 'queued')).all().sort((a, b) => a.runAt - b.runAt)[0];
    if (!next) return;
    clock = Math.max(clock, next.runAt);
    await runDueJobsOnce(worker, clock);
  }
  throw new Error('did not drain');
}

const accounts = () => db.select().from(merchantAccounts).all();

describe('generateMerchantId', () => {
  it('is MID- plus 8 uppercase alphanumerics', () => {
    for (let i = 0; i < 200; i++) expect(generateMerchantId()).toMatch(MERCHANT_ID_RE);
    expect(generateMerchantId(() => 0)).toBe('MID-AAAAAAAA');
    expect(generateMerchantId(() => 35)).toBe('MID-99999999');
  });
});

describe('simulated merchant service', () => {
  it('returns the same MID when asked twice for one application', async () => {
    verifiedApp(db, 'app-1');
    const a = await service.createMerchant('app-1', T0);
    const b = await service.createMerchant('app-1', T0 + 1);
    expect(a).toMatchObject({ created: true, merchantId: expect.stringMatching(MERCHANT_ID_RE) });
    expect(b).toEqual({ created: false, merchantId: a.merchantId });
    expect(accounts()).toHaveLength(1);
  });

  it('regenerates on an ID collision so MIDs stay unique', async () => {
    verifiedApp(db, 'app-1');
    verifiedApp(db, 'app-2');
    const ids = ['MID-AAAAAAAA', 'MID-AAAAAAAA', 'MID-BBBBBBBB'];
    const svc = createSimulatedMerchantService(db, { generate: () => ids.shift()! });
    expect((await svc.createMerchant('app-1', T0)).merchantId).toBe('MID-AAAAAAAA');
    expect((await svc.createMerchant('app-2', T0)).merchantId).toBe('MID-BBBBBBBB');
  });

  it('fails while the failure flag is set, without issuing anything', async () => {
    verifiedApp(db, 'app-1');
    service.fail = true;
    await expect(service.createMerchant('app-1', T0)).rejects.toThrow('Merchant ID service unavailable');
    expect(accounts()).toEqual([]);
    service.fail = false;
    await expect(service.createMerchant('app-1', T0)).resolves.toMatchObject({ created: true });
  });
});

describe('create_merchant job', () => {
  it('APPROVED -> MERCHANT_CREATED with a stored MID', async () => {
    approvedApp();
    await drain();
    const app = appRow(db);
    expect(app.status).toBe('MERCHANT_CREATED');
    expect(app.merchantId).toMatch(MERCHANT_ID_RE);
    expect(auditOf(db).at(-1)).toMatchObject({
      actor: 'system',
      fromState: 'APPROVED',
      toState: 'MERCHANT_CREATED',
      event: 'MERCHANT_CREATED',
      detail: { merchant_id: app.merchantId, attempts: 1 },
    });
    expect(accounts()).toEqual([{ merchantId: app.merchantId, applicationId: 'app-1', createdAt: T0 }]);
  });

  it('retries with backoff, then MERCHANT_CREATION_FAILED plus a review task (no dead job)', async () => {
    approvedApp();
    service.fail = true;
    await drain();
    expect(service.calls).toBe(3);
    expect(appRow(db)).toMatchObject({ status: 'MERCHANT_CREATION_FAILED', merchantId: null });
    const audit = auditOf(db);
    const failures = audit.filter((a) => a.event === 'JOB_FAILED');
    expect(failures.map((a) => [a.at - T0, (a.detail as { attempts: number }).attempts])).toEqual([
      [0, 1],
      [1_000, 2],
    ]);
    expect(audit.at(-1)).toMatchObject({
      fromState: 'APPROVED',
      toState: 'MERCHANT_CREATION_FAILED',
      event: 'MERCHANT_CREATION_FAILED',
      at: T0 + 3_000,
      detail: { attempts: 3 },
    });
    expect(tasksOf(db)).toMatchObject([{ reason: 'MERCHANT_CREATION_FAILED', status: 'OPEN' }]);
    expect(jobsOfType(db, 'create_merchant')).toMatchObject([{ status: 'done', attempts: 3 }]);
    expect(audit.some((a) => a.event === 'JOB_DEAD')).toBe(false);
  });

  it('recovers within the retries when the service comes back', async () => {
    approvedApp();
    service.fail = true;
    await runDueJobsOnce(worker, T0); // attempt 1 fails
    service.fail = false;
    await drain();
    expect(appRow(db).status).toBe('MERCHANT_CREATED');
    expect(jobsOfType(db, 'create_merchant')).toMatchObject([{ status: 'done', attempts: 2 }]);
  });

  it('never creates two MIDs: duplicate jobs, and an ID issued before a crash, are reused', async () => {
    approvedApp();
    // The service issued an ID but the process died before it was recorded on the application.
    const issued = await service.createMerchant('app-1', T0);
    enqueueJob(db, 'create_merchant', { application_id: 'app-1' }, { now: T0 }); // duplicate job
    await drain();
    expect(appRow(db)).toMatchObject({ status: 'MERCHANT_CREATED', merchantId: issued.merchantId });
    expect(accounts()).toHaveLength(1);
    expect(auditOf(db).filter((a) => a.event === 'MERCHANT_CREATED')).toHaveLength(1);
    expect(jobsOfType(db, 'create_merchant').map((j) => j.status)).toEqual(['done', 'done']);
  });

  it('uses a merchant_id already on the application without calling the service', async () => {
    approvedApp();
    db.update(applications).set({ merchantId: 'MID-KNOWN123' }).where(eq(applications.id, 'app-1')).run();
    await drain();
    expect(service.calls).toBe(0);
    expect(appRow(db)).toMatchObject({ status: 'MERCHANT_CREATED', merchantId: 'MID-KNOWN123' });
  });

  it('the DB refuses one MID on two applications', () => {
    verifiedApp(db, 'app-1');
    verifiedApp(db, 'app-2');
    db.update(applications).set({ merchantId: 'MID-SAME0001' }).where(eq(applications.id, 'app-1')).run();
    expect(() => db.update(applications).set({ merchantId: 'MID-SAME0001' }).where(eq(applications.id, 'app-2')).run()).toThrow(
      /UNIQUE/,
    );
  });
});
