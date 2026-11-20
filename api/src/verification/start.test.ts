import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import { applications, verifications } from '../db/schema.js';
import { createJobHandlers } from '../jobs/handlers.js';
import { enqueueJob } from '../jobs/queue.js';
import { runDueJobsOnce, type WorkerDeps } from '../jobs/worker.js';
import { createFakeProviderClient, type FakeProviderClient } from '../providers/fake.js';
import { runStartVerifications, type VerificationDeps } from './start.js';
import { appRow, auditOf, jobsOfType, makeEnv, rowsOf, T0, verifyingApp } from './testkit.js';

let env: ReturnType<typeof makeEnv>;
let db: Db;
let fake: FakeProviderClient;
const deps = (now = T0): VerificationDeps => ({ ...env, now });

beforeEach(() => {
  env = makeEnv();
  db = env.db;
  fake = createFakeProviderClient();
});
afterEach(() => db.$client.close());

describe('start_verifications', () => {
  it('creates four PENDING rows with the current bank_version, stores request ids and schedules timeouts', async () => {
    verifyingApp(db);
    db.update(applications).set({ bankVersion: 3 }).where(eq(applications.id, 'app-1')).run();

    const res = await runStartVerifications(deps(), fake, 'app-1');

    expect(res.requested).toHaveLength(4);
    expect(fake.calls.map((c) => c.kind)).toEqual(['PAN', 'GST', 'BANK', 'RISK']);
    expect(fake.last('BANK')!.body).toMatchObject({ application_ref: 'app-1', bank_version: 3 });

    const rows = rowsOf(db);
    expect(rows.map((r) => [r.kind, r.status, r.attempt, r.bankVersion, r.requestId])).toEqual([
      ['PAN', 'PENDING', 1, 3, 'fake-pan-1'],
      ['GST', 'PENDING', 1, 3, 'fake-gst-2'],
      ['BANK', 'PENDING', 1, 3, 'fake-bank-3'],
      ['RISK', 'PENDING', 1, 3, 'fake-risk-4'],
    ]);

    const timeouts = jobsOfType(db, 'verification_timeout');
    expect(timeouts.map((j) => j.payload)).toEqual(rows.map((r) => ({ application_id: 'app-1', verification_id: r.id })));
    expect(timeouts.every((j) => j.runAt === T0 + env.config.timings.verificationTimeoutMs)).toBe(true);

    const requested = auditOf(db).filter((a) => a.event === 'VERIFICATION_REQUESTED');
    expect(requested).toHaveLength(4);
    expect(requested[0]).toMatchObject({ actor: 'system', fromState: 'VERIFYING', toState: null });
    expect(requested[0]!.detail).toEqual({ kind: 'PAN', attempt: 1, request_id: 'fake-pan-1', bank_version: 3 });
    expect(appRow(db).status).toBe('VERIFYING');
  });

  it('is idempotent: running it again requests nothing new', async () => {
    verifyingApp(db);
    await runStartVerifications(deps(), fake, 'app-1');
    const again = await runStartVerifications(deps(), fake, 'app-1');
    expect(again).toEqual({ requested: [], skipped: ['PAN', 'GST', 'BANK', 'RISK'] });
    expect(rowsOf(db)).toHaveLength(4);
    expect(fake.calls).toHaveLength(4);
  });

  it('a failed provider call fails the job; the retry requests only what is missing and reuses the row', async () => {
    verifyingApp(db);
    fake.failing.add('GST');
    await expect(runStartVerifications(deps(), fake, 'app-1')).rejects.toThrow(/GST provider request failed/);
    expect(rowsOf(db).map((r) => [r.kind, r.requestId === null])).toEqual([
      ['PAN', false],
      ['GST', true],
      ['BANK', false],
      ['RISK', false],
    ]);

    fake.failing.clear();
    const res = await runStartVerifications(deps(T0 + 1_000), fake, 'app-1');
    expect(res.requested.map((r) => r.kind)).toEqual(['GST']);
    expect(res.skipped).toEqual(['PAN', 'BANK', 'RISK']);
    const rows = rowsOf(db);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.requestId !== null && r.attempt === 1)).toBe(true);
    expect(jobsOfType(db, 'verification_timeout')).toHaveLength(4);
  });

  it('a TIMED_OUT check is re-requested as attempt + 1 when its kind is asked for', async () => {
    verifyingApp(db);
    await runStartVerifications(deps(), fake, 'app-1');
    db.update(verifications).set({ status: 'TIMED_OUT' }).where(eq(verifications.kind, 'BANK')).run();

    const res = await runStartVerifications(deps(T0 + 40_000), fake, 'app-1', ['BANK']);
    expect(res.requested.map((r) => [r.kind, r.attempt, r.requestId])).toEqual([['BANK', 2, 'fake-bank-5']]);
    expect(rowsOf(db).filter((r) => r.kind === 'BANK').map((r) => r.status)).toEqual(['TIMED_OUT', 'PENDING']);
  });

  it('does nothing for an application that is not in VERIFYING', async () => {
    verifyingApp(db);
    db.update(applications).set({ status: 'IN_REVIEW' }).where(eq(applications.id, 'app-1')).run();
    const res = await runStartVerifications(deps(), fake, 'app-1');
    expect(res.requested).toEqual([]);
    expect(rowsOf(db)).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('runs as a worker job; a provider outage is retried with backoff and never logs raw values', async () => {
    verifyingApp(db);
    fake.failing.add('PAN');
    const worker: WorkerDeps = { ...env, handlers: createJobHandlers({ providers: fake }) };
    enqueueJob(db, 'start_verifications', { application_id: 'app-1' }, { now: T0 });

    expect(await runDueJobsOnce(worker, T0)).toMatchObject({ claimed: 1, retried: 1 });
    const [job] = jobsOfType(db, 'start_verifications');
    expect(job).toMatchObject({ status: 'queued', attempts: 1, runAt: T0 + 1_000 });
    expect(job!.lastError).toContain('PAN provider request failed');

    fake.failing.clear();
    expect(await runDueJobsOnce(worker, T0 + 1_000)).toMatchObject({ claimed: 1, done: 1 });
    expect(rowsOf(db).filter((r) => r.kind === 'PAN')).toHaveLength(1);
    expect(fake.calls).toHaveLength(4);
  });

  it('rejects a payload with an unknown kind (dead-letters)', async () => {
    verifyingApp(db);
    const worker: WorkerDeps = { ...env, handlers: createJobHandlers({ providers: fake }) };
    enqueueJob(db, 'start_verifications', { application_id: 'app-1', kinds: ['FOO'] }, { now: T0, maxAttempts: 1 });
    expect(await runDueJobsOnce(worker, T0)).toMatchObject({ dead: 1 });
  });
});
