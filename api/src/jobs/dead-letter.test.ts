import { DeadJobDtoSchema, DeadJobListDtoSchema } from '@app/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { appRow, auditOf, makeEnv, T0, tasksOf, verifyingApp } from '../verification/testkit.js';
import { enqueueJob } from './queue.js';
import { runDueJobsOnce, type JobHandlers, type WorkerDeps } from './worker.js';

const RAW_PAN = 'AABCL1234K';
const RAW_ACCOUNT = '50100234567891';

let env: ReturnType<typeof makeEnv>;
let db: Db;
let clock: number;
let fail: boolean;
let runs: number;
let worker: WorkerDeps;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  env = makeEnv();
  db = env.db;
  clock = T0;
  fail = true;
  runs = 0;
  // A test-only handler that fails until told otherwise. The error message
  // carries raw values to prove they are redacted before display.
  const handlers = {
    start_verifications: async () => {
      runs++;
      if (fail) throw new Error(`provider down for ${RAW_PAN} / ${RAW_ACCOUNT}`);
    },
  } as unknown as JobHandlers;
  worker = { ...env, handlers };
  app = createApp({ ...env, now: () => clock });
});
afterEach(() => db.$client.close());

/** A start_verifications job for app-1 that dies after `maxAttempts` failures. */
async function deadJob(maxAttempts = 2, payload: Record<string, unknown> = { application_id: 'app-1', pan: RAW_PAN }) {
  const job = enqueueJob(db, 'start_verifications', payload, { now: clock, maxAttempts });
  for (let i = 0; i < maxAttempts; i++) {
    clock += 60_000;
    await runDueJobsOnce(worker, clock);
  }
  return job;
}

const jobRow = (id: number) => db.select().from(jobs).all().find((j) => j.id === id)!;

describe('GET /jobs?status=dead', () => {
  it('lists dead jobs only, payload masked and error redacted', async () => {
    verifyingApp(db);
    const job = await deadJob();
    enqueueJob(db, 'approve', { application_id: 'app-1' }, { now: clock }); // queued, not listed

    const res = await request(app).get('/jobs?status=dead').expect(200);
    const body = DeadJobListDtoSchema.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: job.id,
      type: 'start_verifications',
      status: 'dead',
      application_id: 'app-1',
      attempts: 2,
      max_attempts: 2,
      payload: { application_id: 'app-1', pan: '******234K' },
    });
    expect(JSON.stringify(res.body)).not.toContain(RAW_PAN);
    expect(JSON.stringify(res.body)).not.toContain(RAW_ACCOUNT);
  });

  it('defaults to dead; other statuses are rejected (400)', async () => {
    expect((await request(app).get('/jobs').expect(200)).body).toEqual({ items: [], count: 0 });
    await request(app).get('/jobs?status=queued').expect(400);
  });
});

describe('POST /jobs/:id/requeue', () => {
  it('resets attempts, makes it due now, resolves its JOB_DEAD task and audits the operator action', async () => {
    verifyingApp(db);
    const job = await deadJob();
    const other = await deadJob(1); // a second dead job for the same app: its task stays open
    expect(tasksOf(db).map((t) => [t.reason, t.status])).toEqual([
      ['JOB_DEAD', 'OPEN'],
      ['JOB_DEAD', 'OPEN'],
    ]);

    clock += 5_000;
    const res = await request(app).post(`/jobs/${job.id}/requeue`).send({ note: 'provider back up' }).expect(200);
    expect(DeadJobDtoSchema.parse(res.body)).toMatchObject({ id: job.id, status: 'queued', attempts: 0, run_at: new Date(clock).toISOString() });
    expect(jobRow(job.id)).toMatchObject({ status: 'queued', attempts: 0, runAt: clock });

    const tasks = tasksOf(db);
    expect(tasks[0]).toMatchObject({ status: 'RESOLVED', resolution: 'REQUEUED', resolutionNote: 'provider back up' });
    expect(tasks[1]).toMatchObject({ status: 'OPEN' });
    expect(tasks[1]!.note).toContain(`#${other.id}`);

    expect(auditOf(db).at(-1)).toMatchObject({
      actor: 'operator',
      event: 'JOB_REQUEUED',
      toState: null,
      fromState: 'VERIFYING',
      detail: { job_id: job.id, type: 'start_verifications', previous_attempts: 2, note: 'provider back up' },
    });
    expect(JSON.stringify(auditOf(db).at(-1))).not.toContain(RAW_PAN);
    expect(appRow(db).status).toBe('VERIFYING');

    // Gone from the list; the worker runs it on the next tick.
    expect((await request(app).get('/jobs?status=dead')).body.items.map((j: { id: number }) => j.id)).toEqual([other.id]);
    fail = false;
    const before = runs;
    await runDueJobsOnce(worker, clock);
    expect(runs).toBe(before + 1);
    expect(jobRow(job.id)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('a requeued job gets its full retry budget again', async () => {
    verifyingApp(db);
    const job = await deadJob(2);
    await request(app).post(`/jobs/${job.id}/requeue`).send({ note: 'provider back up' }).expect(200);
    clock += 1;
    await runDueJobsOnce(worker, clock); // fails: attempt 1 of 2, retried, not dead
    expect(jobRow(job.id)).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('a job without an application is requeued without audit or task changes', async () => {
    const job = await deadJob(1, { note: 'orphan' });
    await request(app).post(`/jobs/${job.id}/requeue`).send({ note: 'provider back up' }).expect(200);
    expect(jobRow(job.id).status).toBe('queued');
  });

  it('409 for a job that is not dead, 404 for an unknown job, 400 for a bad id', async () => {
    const queued = enqueueJob(db, 'approve', { application_id: 'app-1' }, { now: clock });
    const conflict = await request(app).post(`/jobs/${queued.id}/requeue`).send({ note: 'try again' }).expect(409);
    expect(conflict.body.error.message).toContain('only dead jobs can be requeued');
    await request(app).post('/jobs/9999/requeue').send({ note: 'try again' }).expect(404);
    await request(app).post('/jobs/abc/requeue').send({ note: 'try again' }).expect(400);
  });

  it('requires an operator note (400 without, job stays dead); a PAN in the note is masked', async () => {
    verifyingApp(db);
    const job = await deadJob();
    const res = await request(app).post(`/jobs/${job.id}/requeue`).send({}).expect(400);
    expect(JSON.stringify(res.body)).toContain('Note is required');
    await request(app).post(`/jobs/${job.id}/requeue`).send({ note: 'ok' }).expect(400);
    expect(jobRow(job.id).status).toBe('dead');

    await request(app).post(`/jobs/${job.id}/requeue`).send({ note: `retry for ${RAW_PAN}` }).expect(200);
    expect(JSON.stringify(auditOf(db))).not.toContain(RAW_PAN);
  });
});
