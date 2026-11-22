import { MetricsDtoSchema } from '@app/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Db } from '../db/client.js';
import { createApplication } from '../domain/applications.js';
import { transition } from '../domain/transition.js';
import { makeEnv, T0, verifiedApp } from '../verification/testkit.js';
import { computeMetrics, type TransitionRow } from './metrics.js';

const row = (applicationId: string, at: number, toState: TransitionRow['toState']): TransitionRow => ({ applicationId, at, toState });
const state = (m: ReturnType<typeof computeMetrics>, s: string) => m.states.find((x) => x.state === s)!;

describe('computeMetrics (pure)', () => {
  it('averages completed stays per state and ignores the stay in progress', () => {
    const m = computeMetrics(
      [
        row('a', 0, 'SUBMITTED'),
        row('a', 1_000, 'EXTRACTING'),
        row('a', 1_500, 'VERIFYING'),
        row('a', 9_500, 'VERIFIED'),
        row('b', 0, 'SUBMITTED'),
        row('b', 3_000, 'EXTRACTING'),
        row('b', 4_000, 'VERIFYING'),
      ],
      { VERIFIED: 1, VERIFYING: 1 },
    );
    expect(state(m, 'SUBMITTED')).toEqual({ state: 'SUBMITTED', avg_ms: 2_000, completed: 2, current: 0 });
    expect(state(m, 'EXTRACTING')).toEqual({ state: 'EXTRACTING', avg_ms: 750, completed: 2, current: 0 });
    // b is still VERIFYING: only a's 8s stay counts.
    expect(state(m, 'VERIFYING')).toEqual({ state: 'VERIFYING', avg_ms: 8_000, completed: 1, current: 1 });
    expect(state(m, 'VERIFIED')).toEqual({ state: 'VERIFIED', avg_ms: null, completed: 0, current: 1 });
    expect(m.states).toHaveLength(10);
  });

  it('exception rate = applications that ever hit IN_REVIEW or NEEDS_INFO / total', () => {
    const m = computeMetrics(
      [
        row('a', 0, 'SUBMITTED'),
        row('b', 0, 'SUBMITTED'),
        row('b', 1, 'EXTRACTING'),
        row('b', 2, 'NEEDS_INFO'),
        row('b', 3, 'EXTRACTING'),
        row('c', 0, 'SUBMITTED'),
        row('c', 1, 'EXTRACTING'),
        row('c', 2, 'IN_REVIEW'),
        row('c', 3, 'VERIFYING'),
        row('c', 4, 'IN_REVIEW'),
        row('d', 0, 'SUBMITTED'),
      ],
      {},
    );
    expect(m).toMatchObject({ total_applications: 4, exception_count: 2, exception_rate: 0.5 });
    // Re-entering a state counts each stay.
    expect(state(m, 'EXTRACTING').completed).toBe(2);
  });

  it('is all zeros / nulls with no data', () => {
    const m = computeMetrics([], {});
    expect(m).toMatchObject({ total_applications: 0, exception_count: 0, exception_rate: 0 });
    expect(m.states.every((s) => s.avg_ms === null && s.completed === 0 && s.current === 0)).toBe(true);
  });
});

describe('GET /metrics', () => {
  let env: ReturnType<typeof makeEnv>;
  let db: Db;
  beforeEach(() => {
    env = makeEnv();
    db = env.db;
  });
  afterEach(() => db.$client.close());

  it('computes from the audit log over HTTP', async () => {
    // app-1: SUBMITTED/EXTRACTING/VERIFYING at T0 (verifiedApp), VERIFIED at T0, APPROVED at T0+4s.
    verifiedApp(db, 'app-1');
    transition(db, 'app-1', 'APPROVED', { actor: 'system', event: 'AUTO_APPROVED', now: T0 + 4_000 });
    // app-2: NEEDS_INFO after 2s, still there.
    createApplication(db, { merchantName: 'Sunrise Bakery' }, { id: 'app-2', now: T0 });
    transition(db, 'app-2', 'EXTRACTING', { actor: 'system', event: 'EXTRACTION_STARTED', now: T0 + 2_000 });
    transition(db, 'app-2', 'NEEDS_INFO', { actor: 'system', event: 'INFO_REQUIRED', now: T0 + 3_000 });

    const app = createApp({ ...env, now: () => T0 + 10_000 });
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    const m = MetricsDtoSchema.parse(res.body);
    expect(m).toMatchObject({ total_applications: 2, exception_count: 1, exception_rate: 0.5 });
    expect(state(m, 'SUBMITTED')).toMatchObject({ avg_ms: 1_000, completed: 2 }); // 0s and 2s
    expect(state(m, 'VERIFIED')).toMatchObject({ avg_ms: 4_000, completed: 1, current: 0 });
    expect(state(m, 'APPROVED')).toMatchObject({ avg_ms: null, current: 1 });
    expect(state(m, 'NEEDS_INFO')).toMatchObject({ avg_ms: null, current: 1 });
  });
});
