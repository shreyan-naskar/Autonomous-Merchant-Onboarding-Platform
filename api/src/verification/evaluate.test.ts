import type { ProviderCallback, VerificationKind } from '@app/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import { applications } from '../db/schema.js';
import { createFakeProviderClient, type FakeProviderClient } from '../providers/fake.js';
import { receiveCallback } from './callback.js';
import { decideVerification, failureReason, type CheckStates } from './evaluate.js';
import { runStartVerifications } from './start.js';
import { appRow, auditOf, jobsOfType, makeEnv, rowsOf, T0, tasksOf, verifyingApp } from './testkit.js';

const S = (pan?: string, gst?: string, bank?: string, risk?: string) =>
  ({ PAN: pan, GST: gst, BANK: bank, RISK: risk }) as CheckStates;

describe('failureReason / decideVerification (pure)', () => {
  it.each([
    [S('PASSED', 'FAILED', 'PASSED', 'PASSED'), 'PAN_OK_GST_FAILED'],
    [S('PASSED', 'FAILED'), 'PAN_OK_GST_FAILED'],
    [S('FAILED', 'PASSED', 'PASSED', 'PASSED'), 'PAN_FAILED'],
    [S('FAILED', 'FAILED'), 'PAN_FAILED_GST_FAILED'],
    [S('PASSED', 'PASSED', 'FAILED', 'PENDING'), 'PAN_OK_GST_OK_BANK_FAILED'],
    [S(undefined, 'PENDING', 'TIMED_OUT', 'FAILED'), 'PAN_PENDING_GST_PENDING_BANK_TIMED_OUT_RISK_FAILED'],
    [S('PASSED', 'PASSED', 'PASSED', 'PASSED'), null],
    [S('PENDING', 'TIMED_OUT'), null],
  ])('%o -> %s', (states, reason) => {
    expect(failureReason(states)).toBe(reason);
  });

  it('decides VERIFIED only when every check passed, IN_REVIEW on any failure, otherwise waits', () => {
    expect(decideVerification(S('PASSED', 'PASSED', 'PASSED', 'PASSED'))).toEqual({ to: 'VERIFIED' });
    expect(decideVerification(S('PASSED', 'FAILED', 'PENDING'))).toEqual({
      to: 'IN_REVIEW',
      reason: 'PAN_OK_GST_FAILED',
      failed: ['GST'],
    });
    expect(decideVerification(S('PASSED', 'PASSED', 'TIMED_OUT', 'PASSED'))).toEqual({ to: null, waiting: ['BANK'] });
    expect(decideVerification(S())).toEqual({ to: null, waiting: ['PAN', 'GST', 'BANK', 'RISK'] });
  });
});

describe('evaluate() through callbacks', () => {
  let env: ReturnType<typeof makeEnv>;
  let db: Db;
  let fake: FakeProviderClient;
  let n = 0;

  beforeEach(async () => {
    env = makeEnv();
    db = env.db;
    fake = createFakeProviderClient();
    verifyingApp(db);
    await runStartVerifications({ ...env, now: T0 }, fake, 'app-1');
  });
  afterEach(() => db.$client.close());

  const send = (kind: VerificationKind, status: 'PASSED' | 'FAILED' = 'PASSED', extra: Partial<ProviderCallback['result']> = {}) =>
    receiveCallback(
      { ...env, now: T0 + 1_000 * ++n },
      {
        event_id: `e${n}`,
        request_id: fake.last(kind)!.request_id,
        kind,
        result: { status, ...(kind === 'RISK' ? { score: 20 } : {}), ...extra },
        application_ref: 'app-1',
      },
    );
  const transitions = () => auditOf(db).filter((a) => a.toState !== null).map((a) => `${a.toState} ${a.event}`);

  it('stays in VERIFYING until all four pass, then VERIFIED with an approve job', () => {
    send('PAN');
    send('GST');
    send('BANK');
    expect(appRow(db).status).toBe('VERIFYING');
    expect(jobsOfType(db, 'approve')).toEqual([]);

    send('RISK');
    expect(appRow(db).status).toBe('VERIFIED');
    expect(auditOf(db).at(-1)).toMatchObject({
      event: 'ALL_CHECKS_PASSED',
      fromState: 'VERIFYING',
      toState: 'VERIFIED',
      detail: { checks: { PAN: 'PASSED', GST: 'PASSED', BANK: 'PASSED', RISK: 'PASSED' }, risk_score: 20, bank_version: 1 },
    });
    expect(jobsOfType(db, 'approve').map((j) => j.payload)).toEqual([{ application_id: 'app-1' }]);
    expect(tasksOf(db)).toEqual([]);
  });

  it('GST failure with PAN passed -> IN_REVIEW with PAN_OK_GST_FAILED and a descriptive task', () => {
    send('PAN');
    send('GST', 'FAILED', { reason: 'GSTIN_INACTIVE' });
    expect(appRow(db).status).toBe('IN_REVIEW');
    const [task] = tasksOf(db);
    expect(task).toMatchObject({ reason: 'PAN_OK_GST_FAILED', status: 'OPEN' });
    expect(task!.note).toBe(
      'Verification failed: GST. PAN: passed, attempt 1; GST: failed (GSTIN_INACTIVE), attempt 1; BANK: pending, attempt 1; RISK: pending, attempt 1',
    );
    expect(auditOf(db).at(-1)).toMatchObject({
      event: 'VERIFICATION_FAILED',
      toState: 'IN_REVIEW',
      detail: { reason: 'PAN_OK_GST_FAILED', failed: ['GST'], checks: { PAN: 'PASSED', GST: 'FAILED', BANK: 'PENDING', RISK: 'PENDING' } },
    });
  });

  it('callbacks arriving in IN_REVIEW are recorded but do not move the application', () => {
    send('PAN');
    send('GST', 'FAILED');
    send('BANK');
    send('RISK');
    expect(appRow(db).status).toBe('IN_REVIEW');
    expect(transitions()).toEqual(['SUBMITTED APPLICATION_SUBMITTED', 'EXTRACTING EXTRACTION_STARTED', 'VERIFYING VERIFICATION_STARTED', 'IN_REVIEW VERIFICATION_FAILED']);
    expect(rowsOf(db).map((r) => r.status)).toEqual(['PASSED', 'FAILED', 'PASSED', 'PASSED']);
    expect(auditOf(db).filter((a) => a.event === 'VERIFICATION_RESULT').at(-1)).toMatchObject({ fromState: 'IN_REVIEW', toState: null });
    expect(tasksOf(db)).toHaveLength(1);
  });

  it('a high risk score still counts as PASSED (routing is the approve step)', () => {
    send('PAN');
    send('GST');
    send('BANK');
    send('RISK', 'PASSED', { score: 85 });
    expect(appRow(db).status).toBe('VERIFIED');
  });

  it('does nothing outside VERIFYING', () => {
    db.update(applications).set({ status: 'IN_REVIEW' }).where(eq(applications.id, 'app-1')).run();
    for (const k of ['PAN', 'GST', 'BANK', 'RISK'] as const) send(k);
    expect(appRow(db).status).toBe('IN_REVIEW');
    expect(jobsOfType(db, 'approve')).toEqual([]);
  });
});
