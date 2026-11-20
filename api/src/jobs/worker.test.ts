import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/client.js';
import { auditLog, jobs, reviewTasks } from '../db/schema.js';
import { createApplication } from '../domain/applications.js';
import { createLogger } from '../logger.js';
import { enqueueJob } from './queue.js';
import { backoffDelayMs, claimDueJobs, runDueJobsOnce, startWorker, type JobHandlers, type WorkerDeps } from './worker.js';

const T0 = 1_700_000_000_000;
const BASE = 1_000; // DEMO_MODE backoff base
let db: Db;
let appId: string;

const config = loadConfig({ DB_PATH: ':memory:' });
const logger = createLogger({ level: 'silent' });
const deps = (handlers: JobHandlers): WorkerDeps => ({ db, config, logger, handlers });
const job = (id: number) => db.select().from(jobs).where(eq(jobs.id, id)).get()!;
const auditEvents = () =>
  db.select().from(auditLog).where(eq(auditLog.applicationId, appId)).all().filter((a) => a.event.startsWith('JOB_'));

beforeEach(() => {
  db = openDb(':memory:');
  appId = createApplication(db, { merchantName: 'Acme Traders' }, { now: T0, id: 'app-1' }).id;
});
afterEach(() => db.$client.close());

describe('backoffDelayMs', () => {
  it('doubles from the base per failed attempt', () => {
    expect([1, 2, 3, 4, 5].map((n) => backoffDelayMs(BASE, n))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });
  it('uses the configured base (demo 1s, non-demo 60s)', () => {
    expect(config.timings.backoffBaseMs).toBe(1_000);
    expect(loadConfig({ DEMO_MODE: 'false' }).timings.backoffBaseMs).toBe(60_000);
  });
});

describe('claimDueJobs', () => {
  it('claims only queued jobs whose run_at has passed, oldest first, and counts the attempt', () => {
    const later = enqueueJob(db, 'extract', { application_id: appId }, { now: T0, runAt: T0 + 5_000 });
    const second = enqueueJob(db, 'extract', { application_id: appId }, { now: T0, runAt: T0 + 10 });
    const first = enqueueJob(db, 'extract', { application_id: appId }, { now: T0, runAt: T0 });

    const claimed = claimDueJobs(db, T0 + 10, 10);
    expect(claimed.map((j) => j.id)).toEqual([first.id, second.id]);
    expect(claimed.every((j) => j.status === 'running' && j.attempts === 1)).toBe(true);
    expect(job(later.id).status).toBe('queued');
  });

  it('never hands the same job out twice', () => {
    enqueueJob(db, 'extract', {}, { now: T0 });
    expect(claimDueJobs(db, T0, 10)).toHaveLength(1);
    expect(claimDueJobs(db, T0, 10)).toHaveLength(0);
  });

  it('respects the batch limit', () => {
    for (let i = 0; i < 5; i++) enqueueJob(db, 'extract', {}, { now: T0 });
    expect(claimDueJobs(db, T0, 3)).toHaveLength(3);
    expect(claimDueJobs(db, T0, 3)).toHaveLength(2);
  });
});

describe('runDueJobsOnce', () => {
  it('runs the handler registered for the job type with the payload and tick clock', async () => {
    const extract = vi.fn();
    const j = enqueueJob(db, 'extract', { application_id: appId }, { now: T0 });
    const r = await runDueJobsOnce(deps({ extract }), T0);

    expect(r).toEqual({ claimed: 1, done: 1, retried: 0, dead: 0 });
    expect(extract).toHaveBeenCalledOnce();
    expect(extract.mock.calls[0]![0]).toEqual({ application_id: appId });
    expect(extract.mock.calls[0]![1]).toMatchObject({ now: T0, db, job: { id: j.id } });
    expect(job(j.id)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('does nothing before run_at', async () => {
    const extract = vi.fn();
    enqueueJob(db, 'extract', {}, { now: T0, runAt: T0 + 1 });
    expect((await runDueJobsOnce(deps({ extract }), T0)).claimed).toBe(0);
    expect(extract).not.toHaveBeenCalled();
  });

  it('awaits async handlers and treats a rejection as a failure', async () => {
    const j = enqueueJob(db, 'extract', { application_id: appId }, { now: T0 });
    const r = await runDueJobsOnce(deps({ extract: async () => Promise.reject(new Error('boom')) }), T0);
    expect(r.retried).toBe(1);
    expect(job(j.id).status).toBe('queued');
  });

  it('retries with exponential backoff, then dead-letters after max_attempts', async () => {
    const extract = vi.fn(() => {
      throw new Error('provider exploded');
    });
    const j = enqueueJob(db, 'extract', { application_id: appId }, { now: T0, maxAttempts: 4 });
    let clock = T0;

    // Attempts 1-3 fail and are rescheduled at clock + 1s, 2s, 4s.
    for (const [attempt, delay] of [
      [1, 1_000],
      [2, 2_000],
      [3, 4_000],
    ] as const) {
      expect(await runDueJobsOnce(deps({ extract }), clock)).toMatchObject({ claimed: 1, retried: 1 });
      expect(job(j.id)).toMatchObject({ status: 'queued', attempts: attempt, runAt: clock + delay, lastError: 'provider exploded' });

      // Not due 1ms early.
      expect((await runDueJobsOnce(deps({ extract }), clock + delay - 1)).claimed).toBe(0);
      clock += delay;
    }

    // Attempt 4 = max_attempts: dead.
    expect(await runDueJobsOnce(deps({ extract }), clock)).toMatchObject({ claimed: 1, dead: 1 });
    expect(job(j.id)).toMatchObject({ status: 'dead', attempts: 4 });
    expect(extract).toHaveBeenCalledTimes(4);

    // Dead jobs are never picked up again.
    expect((await runDueJobsOnce(deps({ extract }), clock + 1e9)).claimed).toBe(0);

    // Audit: three JOB_FAILED then one JOB_DEAD, none changing status.
    const events = auditEvents();
    expect(events.map((e) => e.event)).toEqual(['JOB_FAILED', 'JOB_FAILED', 'JOB_FAILED', 'JOB_DEAD']);
    expect(events.every((e) => e.toState === null && e.fromState === 'SUBMITTED' && e.actor === 'system')).toBe(true);
    expect(events[0]!.detail).toMatchObject({ job_id: j.id, type: 'extract', attempts: 1, next_run_at: new Date(T0 + 1_000).toISOString() });
    expect(events[3]!.detail).toMatchObject({ job_id: j.id, attempts: 4, max_attempts: 4, error: 'provider exploded' });

    // One JOB_DEAD review task.
    const tasks = db.select().from(reviewTasks).where(eq(reviewTasks.applicationId, appId)).all();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ reason: 'JOB_DEAD', status: 'OPEN', createdAt: clock });
  });

  it('recovers when a retry succeeds', async () => {
    let calls = 0;
    const extract = () => {
      if (++calls === 1) throw new Error('transient');
    };
    const j = enqueueJob(db, 'extract', { application_id: appId }, { now: T0 });
    await runDueJobsOnce(deps({ extract }), T0);
    await runDueJobsOnce(deps({ extract }), T0 + 1_000);
    expect(job(j.id)).toMatchObject({ status: 'done', attempts: 2 });
    expect(auditEvents().map((e) => e.event)).toEqual(['JOB_FAILED']);
    expect(db.select().from(reviewTasks).all()).toHaveLength(0);
  });

  it('dead-letters a job with no registered handler immediately', async () => {
    const j = enqueueJob(db, 'approve', { application_id: appId }, { now: T0 });
    expect(await runDueJobsOnce(deps({}), T0)).toMatchObject({ dead: 1 });
    expect(job(j.id)).toMatchObject({ status: 'dead', attempts: 1, lastError: 'No handler for job type approve' });
    expect(db.select().from(reviewTasks).all()).toHaveLength(1);
  });

  it('dead-letters a job without an application_id without auditing (logged only)', async () => {
    const j = enqueueJob(db, 'extract', {}, { now: T0, maxAttempts: 1 });
    await runDueJobsOnce(deps({ extract: () => { throw new Error('x'); } }), T0);
    expect(job(j.id).status).toBe('dead');
    expect(auditEvents()).toHaveLength(0);
    expect(db.select().from(reviewTasks).all()).toHaveLength(0);
  });

  it('masks PAN/account-shaped text in stored errors', async () => {
    const j = enqueueJob(db, 'extract', { application_id: appId }, { now: T0 });
    await runDueJobsOnce(deps({ extract: () => { throw new Error('bad PAN ABCDE1234F acct 50100234567891'); } }), T0);
    const stored = JSON.stringify([job(j.id).lastError, auditEvents()]);
    expect(stored).not.toContain('ABCDE1234F');
    expect(stored).not.toContain('50100234567891');
    expect(stored).toContain('******234F');
  });

  it('keeps going after one job fails', async () => {
    const a = enqueueJob(db, 'extract', { application_id: appId, n: 1 }, { now: T0 });
    const b = enqueueJob(db, 'extract', { application_id: appId, n: 2 }, { now: T0 });
    const r = await runDueJobsOnce(
      deps({ extract: (p) => { if (p.n === 1) throw new Error('first fails'); } }),
      T0,
    );
    expect(r).toMatchObject({ claimed: 2, done: 1, retried: 1 });
    expect(job(a.id).status).toBe('queued');
    expect(job(b.id).status).toBe('done');
  });
});

describe('startWorker', () => {
  it('polls on an interval with the injected clock and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const extract = vi.fn();
      enqueueJob(db, 'extract', { application_id: appId }, { now: T0 });
      const w = startWorker(deps({ extract }), { now: () => T0, intervalMs: 100 });
      expect(extract).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(extract).toHaveBeenCalledOnce();
      await w.stop();
      enqueueJob(db, 'extract', { application_id: appId }, { now: T0 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(extract).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not overlap ticks while a handler is still running', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const extract = vi.fn(() => new Promise<void>((r) => (release = r)));
      enqueueJob(db, 'extract', { application_id: appId }, { now: T0 });
      enqueueJob(db, 'extract', { application_id: appId }, { now: T0 + 1, runAt: T0 + 1 });
      const w = startWorker(deps({ extract }), { now: () => T0, intervalMs: 100 });
      await vi.advanceTimersByTimeAsync(500);
      expect(extract).toHaveBeenCalledOnce();
      release();
      const stopping = w.stop();
      await stopping;
    } finally {
      vi.useRealTimers();
    }
  });
});
