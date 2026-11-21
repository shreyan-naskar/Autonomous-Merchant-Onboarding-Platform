import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jobs } from './db/schema.js';
import { events, openTask, sample, startE2E, type E2E } from './e2e.js';

/* Providers answer 503: the job retries with backoff, dead-letters, and completes once requeued after the outage. */

let e: E2E;
beforeEach(async () => {
  e = await startE2E();
});
afterEach(() => e.close());

describe('provider outage', () => {
  it('retries with backoff, dead-letters after 5 attempts, and completes after a requeue', async () => {
    await e.setChaos({ outage: true });
    const id = await e.submit(sample('happy.json'));
    await e.drain(60_000); // extract, then start_verifications x5 (1s, 2s, 4s, 8s backoff)

    let d = await e.detail(id);
    expect(d.status).toBe('VERIFYING');
    expect(events(d, 'JOB_FAILED')).toHaveLength(4);
    expect(events(d, 'JOB_DEAD')).toHaveLength(1);
    expect(openTask(d, 'JOB_DEAD').note).toContain('503');

    const dead = await e.api().get('/jobs?status=dead').expect(200);
    expect(dead.body.items).toMatchObject([{ type: 'start_verifications', attempts: 5, application_id: id }]);

    await e.setChaos({ outage: false });
    await e.api().post(`/jobs/${dead.body.items[0].id}/requeue`).send({ note: 'provider outage over' }).expect(200);
    await e.drain();
    await e.deliver();
    await e.drain();
    d = await e.detail(id);
    expect(d.status).toBe('MERCHANT_CREATED');
    expect(e.db.select().from(jobs).all().filter((j) => j.status === 'dead')).toEqual([]);
  });
});
