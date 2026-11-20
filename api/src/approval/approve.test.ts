import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import { transition } from '../domain/transition.js';
import { appRow, auditOf, jobsOfType, makeEnv, T0, tasksOf, verifiedApp } from '../verification/testkit.js';
import { runApprove } from './approve.js';

let env: ReturnType<typeof makeEnv>;
let db: Db;
const ctx = () => ({ ...env, now: T0 + 1_000 });

beforeEach(() => {
  env = makeEnv();
  db = env.db;
});
afterEach(() => db.$client.close());

describe('approve job', () => {
  it.each([0, 40, 70])('risk %i (<= 70) auto-approves and enqueues create_merchant', (score) => {
    verifiedApp(db, 'app-1', { riskScore: score });
    expect(runApprove(ctx(), 'app-1')).toBe('approved');
    expect(appRow(db).status).toBe('APPROVED');
    expect(auditOf(db).at(-1)).toMatchObject({
      actor: 'system',
      fromState: 'VERIFIED',
      toState: 'APPROVED',
      event: 'AUTO_APPROVED',
      detail: { risk_score: score, risk_threshold: 70 },
    });
    expect(jobsOfType(db, 'create_merchant')).toMatchObject([{ status: 'queued', maxAttempts: 3, payload: { application_id: 'app-1' } }]);
    expect(tasksOf(db)).toEqual([]);
  });

  it.each([71, 85])('risk %i (> 70) goes to IN_REVIEW with a HIGH_RISK task', (score) => {
    verifiedApp(db, 'app-1', { riskScore: score });
    expect(runApprove(ctx(), 'app-1')).toBe('high_risk');
    expect(appRow(db).status).toBe('IN_REVIEW');
    expect(auditOf(db).at(-1)).toMatchObject({ toState: 'IN_REVIEW', event: 'HIGH_RISK', detail: { risk_score: score } });
    expect(tasksOf(db)).toMatchObject([
      { reason: 'HIGH_RISK', status: 'OPEN', note: `Risk score ${score} is above the auto-approval threshold of 70` },
    ]);
    expect(jobsOfType(db, 'create_merchant')).toEqual([]);
  });

  it('treats a missing risk score as high risk', () => {
    verifiedApp(db, 'app-1', { riskScore: null });
    expect(runApprove(ctx(), 'app-1')).toBe('high_risk');
    expect(tasksOf(db)[0]!.reason).toBe('HIGH_RISK');
  });

  it('respects a configured RISK_THRESHOLD', () => {
    verifiedApp(db, 'app-1', { riskScore: 50 });
    const config = { ...env.config, thresholds: { ...env.config.thresholds, risk: 40 } };
    expect(runApprove({ ...ctx(), config }, 'app-1')).toBe('high_risk');
  });

  it('is a no-op outside VERIFIED (a second approve job, or the bank changed meanwhile)', () => {
    verifiedApp(db);
    transition(db, 'app-1', 'IN_REVIEW', { actor: 'merchant', event: 'BANK_CHANGED', now: T0 });
    const before = auditOf(db).length;
    expect(runApprove(ctx(), 'app-1')).toBe('skipped');
    expect(auditOf(db)).toHaveLength(before);
    expect(runApprove(ctx(), 'missing')).toBe('skipped');
  });
});
