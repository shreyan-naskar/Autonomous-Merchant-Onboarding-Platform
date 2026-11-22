import type { VerificationKind } from '@app/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import { applications, jobs, verifications } from '../db/schema.js';
import { createJobHandlers } from '../jobs/handlers.js';
import { runDueJobsOnce, type WorkerDeps } from '../jobs/worker.js';
import { createFakeProviderClient, type FakeProviderClient } from '../providers/fake.js';
import { receiveCallback } from './callback.js';
import { runStartVerifications } from './start.js';
import { runVerificationTimeout } from './timeout.js';
import { appRow, auditOf, jobsOfType, makeEnv, rowsOf, T0, tasksOf, verifyingApp } from './testkit.js';

let env: ReturnType<typeof makeEnv>;
let db: Db;
let fake: FakeProviderClient;
let worker: WorkerDeps;
let clock: number;
let n = 0;

beforeEach(async () => {
  env = makeEnv();
  db = env.db;
  fake = createFakeProviderClient();
  worker = { ...env, handlers: createJobHandlers({ providers: fake }) };
  clock = T0;
  verifyingApp(db);
  await runStartVerifications({ ...env, now: T0 }, fake, 'app-1');
});
afterEach(() => db.$client.close());

const pass = (kind: VerificationKind) =>
  receiveCallback(
    { ...env, now: clock },
    { event_id: `e${++n}`, request_id: fake.last(kind)!.request_id, kind, result: { status: 'PASSED', score: 5 }, application_ref: 'app-1' },
  );

/** Advance the clock to `at` and run every job due by then. */
async function runUntil(at: number) {
  while (true) {
    const due = db.select().from(jobs).all().filter((j) => j.status === 'queued' && j.runAt <= at);
    if (due.length === 0) break;
    clock = Math.max(clock, Math.min(...due.map((j) => j.runAt)));
    await runDueJobsOnce(worker, clock);
  }
  clock = at;
}

const bank = () => rowsOf(db).filter((r) => r.kind === 'BANK');
const TIMEOUT = 30_000;

describe('verification_timeout', () => {
  it('times out, retries twice with backoff, then escalates to IN_REVIEW with BANK_TIMEOUT', async () => {
    pass('PAN');
    pass('GST');
    pass('RISK');

    // Attempt 1 times out at +30s; the retry is requested 1s later (backoff base).
    await runUntil(T0 + TIMEOUT);
    expect(bank().map((r) => [r.attempt, r.status])).toEqual([[1, 'TIMED_OUT']]);
    expect(auditOf(db).at(-1)).toMatchObject({
      event: 'VERIFICATION_TIMED_OUT',
      toState: null,
      detail: { kind: 'BANK', attempt: 1, retry_attempt: 2, retry_at: new Date(T0 + TIMEOUT + 1_000).toISOString() },
    });
    await runUntil(T0 + TIMEOUT + 1_000);
    expect(bank().map((r) => [r.attempt, r.status, r.requestedAt])).toEqual([
      [1, 'TIMED_OUT', T0],
      [2, 'PENDING', T0 + TIMEOUT + 1_000],
    ]);
    expect(fake.last('BANK')!.request_id).toBe(bank()[1]!.requestId);

    // Attempt 2 times out; attempt 3 follows after 2s.
    await runUntil(T0 + 2 * TIMEOUT + 1_000);
    await runUntil(T0 + 2 * TIMEOUT + 3_000);
    expect(bank().map((r) => [r.attempt, r.status])).toEqual([
      [1, 'TIMED_OUT'],
      [2, 'TIMED_OUT'],
      [3, 'PENDING'],
    ]);
    expect(appRow(db).status).toBe('VERIFYING');

    // Attempt 3 times out: no retries left.
    await runUntil(T0 + 3 * TIMEOUT + 3_000);
    expect(appRow(db).status).toBe('IN_REVIEW');
    expect(tasksOf(db)).toMatchObject([{ reason: 'BANK_TIMEOUT', status: 'OPEN' }]);
    expect(auditOf(db).at(-1)).toMatchObject({
      event: 'VERIFICATION_TIMED_OUT',
      fromState: 'VERIFYING',
      toState: 'IN_REVIEW',
      detail: { reason: 'BANK_TIMEOUT', kind: 'BANK', attempts: 3 },
    });
    expect(fake.calls.filter((c) => c.kind === 'BANK')).toHaveLength(3);
    expect(jobsOfType(db, 'verification_timeout').every((j) => j.status === 'done')).toBe(true);
  });

  it('is a no-op when the check already has a result', async () => {
    pass('BANK');
    const id = bank()[0]!.id;
    expect(runVerificationTimeout({ ...env, now: T0 + TIMEOUT }, id)).toBe('not_pending');
    expect(bank()[0]!.status).toBe('PASSED');
  });

  it('is a no-op for a superseded row or an old bank_version', async () => {
    const [b] = bank();
    db.update(applications).set({ bankVersion: 2 }).where(eq(applications.id, 'app-1')).run();
    expect(runVerificationTimeout({ ...env, now: T0 + TIMEOUT }, b!.id)).toBe('not_pending');
    const pan = rowsOf(db).find((r) => r.kind === 'PAN')!;
    db.update(verifications).set({ superseded: true }).where(eq(verifications.id, pan.id)).run();
    expect(runVerificationTimeout({ ...env, now: T0 + TIMEOUT }, pan.id)).toBe('not_pending');
    expect(rowsOf(db).every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('outside VERIFYING it only marks TIMED_OUT (no retry, no transition)', async () => {
    db.update(applications).set({ status: 'IN_REVIEW' }).where(eq(applications.id, 'app-1')).run();
    expect(runVerificationTimeout({ ...env, now: T0 + TIMEOUT }, bank()[0]!.id)).toBe('timed_out');
    expect(bank()[0]!.status).toBe('TIMED_OUT');
    expect(jobsOfType(db, 'start_verifications')).toEqual([]);
    expect(appRow(db).status).toBe('IN_REVIEW');
  });

  it('a late callback before the retry runs makes the retry a no-op', async () => {
    pass('PAN');
    pass('GST');
    pass('RISK');
    const firstBank = fake.last('BANK')!.request_id;
    await runUntil(T0 + TIMEOUT); // TIMED_OUT, retry queued for +1s
    receiveCallback(
      { ...env, now: clock + 500 },
      { event_id: 'late', request_id: firstBank, kind: 'BANK', result: { status: 'PASSED' }, application_ref: 'app-1' },
    );
    expect(appRow(db).status).toBe('VERIFIED');
    await runUntil(T0 + TIMEOUT + 5_000);
    expect(bank()).toHaveLength(1);
    expect(fake.calls.filter((c) => c.kind === 'BANK')).toHaveLength(1);
  });
});
