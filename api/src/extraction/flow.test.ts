import { ApplicationDetailDtoSchema, type ApplicationDetailDto } from '@app/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/client.js';
import { applications, jobs } from '../db/schema.js';
import { transition } from '../domain/transition.js';
import { createJobHandlers } from '../jobs/handlers.js';
import { runDueJobsOnce, type WorkerDeps } from '../jobs/worker.js';
import { createLogger } from '../logger.js';
import { createFakeProviderClient } from '../providers/fake.js';
import { sample } from '../testing.js';

/*
 * Extraction outcomes per sample, over HTTP with the worker. Providers are the
 * in-memory fake (no callbacks), so VERIFYING is as far as these go.
 */


const T0 = 1_700_000_000_000;
let clock: number;
let db: Db;
let app: ReturnType<typeof createApp>;
let worker: WorkerDeps;

beforeEach(() => {
  clock = T0;
  db = openDb(':memory:');
  const config = loadConfig({ DB_PATH: ':memory:' });
  const logger = createLogger({ level: 'silent' });
  app = createApp({ config, logger, db, now: () => clock });
  worker = { db, config, logger, handlers: createJobHandlers({ providers: createFakeProviderClient() }) };
});
afterEach(() => db.$client.close());


/** Run worker ticks (advancing the clock 1s each) until no job is due. */
async function drain(maxTicks = 20) {
  for (let i = 0; i < maxTicks; i++) {
    clock += 1_000;
    if ((await runDueJobsOnce(worker, clock)).claimed === 0) return;
  }
  throw new Error('worker did not go idle');
}

async function submit(body: unknown): Promise<string> {
  const res = await request(app).post('/applications').send(body as object);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function get(id: string): Promise<ApplicationDetailDto> {
  const res = await request(app).get(`/applications/${id}`);
  expect(res.status).toBe(200);
  return ApplicationDetailDtoSchema.parse(res.body);
}

// Status transitions only (non-transition events such as VERIFICATION_REQUESTED are left out).
const trail = (dto: ApplicationDetailDto) =>
  dto.audit_log.filter((a) => a.to_state !== null).map((a) => `${a.from_state ?? '-'}>${a.to_state ?? '-'} ${a.event}`);
const jobsOf = (id: string) =>
  db.select().from(jobs).all().filter((j) => (j.payload as { application_id?: string }).application_id === id);

describe('extraction flow with the worker', () => {
  it('happy.json reaches VERIFYING with seven ok fields and a queued start_verifications', async () => {
    const id = await submit(sample('happy.json'));
    await drain();
    const dto = await get(id);

    expect(dto.status).toBe('VERIFYING');
    expect(trail(dto)).toEqual([
      '->SUBMITTED APPLICATION_SUBMITTED',
      'SUBMITTED>EXTRACTING EXTRACTION_STARTED',
      'EXTRACTING>VERIFYING VERIFICATION_STARTED',
    ]);
    expect(dto.extracted_fields).toHaveLength(7);
    expect(dto.extracted_fields.every((f) => f.confidence === 1 && f.validation_status === 'ok')).toBe(true);
    // Sensitive extracted values are masked in the response.
    expect(dto.extracted_fields.find((f) => f.field === 'pan')!.value).toBe('******234K');
    expect(dto.extracted_fields.find((f) => f.field === 'bank_account')!.value).toBe('**********7891');
    expect(dto.review_tasks).toEqual([]);

    // extract done; start_verifications ran and scheduled one timeout per request.
    expect(jobsOf(id).map((j) => [j.type, j.status])).toEqual([
      ['extract', 'done'],
      ['start_verifications', 'done'],
      ...Array(4).fill(['verification_timeout', 'queued']),
    ]);
  });

  it('missing.json ends in NEEDS_INFO with the missing list in the audit detail', async () => {
    const id = await submit(sample('missing.json'));
    await drain();
    const dto = await get(id);

    expect(dto.status).toBe('NEEDS_INFO');
    expect(dto.audit_log.at(-1)).toMatchObject({
      actor: 'system',
      from_state: 'EXTRACTING',
      to_state: 'NEEDS_INFO',
      event: 'INFO_REQUIRED',
      detail: { reason: 'MISSING_INFO', missing: ['document.GST_CERT'] },
    });
    expect(dto.review_tasks).toEqual([]);
    expect(jobsOf(id).map((j) => j.type)).toEqual(['extract']);
  });

  it('conflict.json ends in IN_REVIEW with an open DOC_CONFLICT task', async () => {
    const id = await submit(sample('conflict.json'));
    await drain();
    const dto = await get(id);

    expect(dto.status).toBe('IN_REVIEW');
    expect(dto.review_tasks).toHaveLength(1);
    expect(dto.review_tasks[0]).toMatchObject({ reason: 'DOC_CONFLICT', status: 'OPEN' });
    expect(dto.review_tasks[0]!.note).toContain('PAN_CARD.name (name_mismatch');
    expect(dto.open_review_count).toBe(1);
    expect(dto.audit_log.at(-1)).toMatchObject({
      to_state: 'IN_REVIEW',
      event: 'DOC_CONFLICT',
      detail: { reason: 'DOC_CONFLICT', conflicts: [{ document: 'PAN_CARD', field: 'name', issue: 'name_mismatch' }] },
    });
    expect(dto.extracted_fields.find((f) => f.field === 'name')!.validation_status).toBe('mismatch');
    // No verification for an app under review.
    expect(jobsOf(id).map((j) => j.type)).toEqual(['extract']);
  });

  it('a malformed document value ends in IN_REVIEW with a LOW_CONFIDENCE task', async () => {
    const body = sample('happy.json');
    body.documents[2].payload.ifsc = 'HDFC1001234';
    const id = await submit(body);
    await drain();
    const dto = await get(id);

    expect(dto.status).toBe('IN_REVIEW');
    expect(dto.review_tasks.map((t) => t.reason)).toEqual(['LOW_CONFIDENCE']);
    expect(dto.extracted_fields.find((f) => f.field === 'ifsc')).toMatchObject({
      confidence: 0.5,
      validation_status: 'low_confidence',
    });
  });

  it('gst-fail.json passes extraction (only the GST provider rejects it)', async () => {
    const id = await submit(sample('gst-fail.json'));
    await drain();
    expect((await get(id)).status).toBe('VERIFYING');
  });

  it('a stale extract job (app already moved on) is a no-op', async () => {
    const id = await submit(sample('happy.json'));
    await drain();
    const { enqueueJob } = await import('../jobs/queue.js');
    enqueueJob(db, 'extract', { application_id: id }, { now: clock });
    await drain();
    const dto = await get(id);
    expect(dto.status).toBe('VERIFYING');
    expect(trail(dto)).toHaveLength(3);
    expect(dto.audit_log.filter((a) => a.event === 'VERIFICATION_REQUESTED')).toHaveLength(4);
  });

  it('a crash after EXTRACTING is retried and completes (idempotent)', async () => {
    const id = await submit(sample('happy.json'));
    // Simulate a previous attempt that moved to EXTRACTING and then died.
    transition(db, id, 'EXTRACTING', { actor: 'system', event: 'EXTRACTION_STARTED', now: clock });
    await drain();
    const dto = await get(id);
    expect(dto.status).toBe('VERIFYING');
    expect(dto.extracted_fields).toHaveLength(7);
  });
});

describe('PATCH in NEEDS_INFO moves the application forward', () => {
  const gstCert = sample('happy.json').documents[1];
  const missingGst = () => {
    const s = sample('missing.json');
    return { type: 'GST_CERT', payload: { gstin: s.gst, legal_name: s.merchant_name } };
  };

  it('missing.json + the GST certificate: NEEDS_INFO -> EXTRACTING (merchant) -> VERIFYING', async () => {
    const id = await submit(sample('missing.json'));
    await drain();
    expect((await get(id)).status).toBe('NEEDS_INFO');

    clock += 60_000;
    const res = await request(app).patch(`/applications/${id}`).send({ documents: [missingGst()] });
    expect(res.status).toBe(200);
    const patched = ApplicationDetailDtoSchema.parse(res.body);
    expect(patched.status).toBe('EXTRACTING');
    expect(patched.audit_log.at(-1)).toMatchObject({
      actor: 'merchant',
      from_state: 'NEEDS_INFO',
      to_state: 'EXTRACTING',
      event: 'INFO_SUPPLIED',
      detail: { fields: [], documents: ['GST_CERT'] },
    });
    expect(jobsOf(id).filter((j) => j.type === 'extract').map((j) => j.status)).toEqual(['done', 'queued']);

    await drain();
    const dto = await get(id);
    expect(dto.status).toBe('VERIFYING');
    expect(trail(dto)).toEqual([
      '->SUBMITTED APPLICATION_SUBMITTED',
      'SUBMITTED>EXTRACTING EXTRACTION_STARTED',
      'EXTRACTING>NEEDS_INFO INFO_REQUIRED',
      'NEEDS_INFO>EXTRACTING INFO_SUPPLIED',
      'EXTRACTING>VERIFYING VERIFICATION_STARTED',
    ]);
    // Re-extraction replaced the field snapshot rather than appending to it.
    expect(dto.extracted_fields).toHaveLength(7);
    expect(dto.documents.map((d) => d.type).sort()).toEqual(['BANK_PROOF', 'GST_CERT', 'PAN_CARD']);
  });

  it('a missing form field supplied by PATCH also moves forward', async () => {
    const body = sample('happy.json');
    delete body.ifsc;
    const id = await submit(body);
    await drain();
    const before = await get(id);
    expect(before.status).toBe('NEEDS_INFO');
    expect(before.audit_log.at(-1)!.detail).toMatchObject({ missing: ['form.ifsc'] });

    const res = await request(app).patch(`/applications/${id}`).send({ ifsc: 'hdfc0001234' });
    expect(res.status).toBe(200);
    expect(res.body.audit_log.at(-1)).toMatchObject({ event: 'INFO_SUPPLIED', detail: { fields: ['ifsc'], documents: [] } });
    await drain();
    expect((await get(id)).status).toBe('VERIFYING');
  });

  it('supplying info that is still incomplete goes back to NEEDS_INFO', async () => {
    const id = await submit(sample('missing.json'));
    await drain();
    await request(app)
      .patch(`/applications/${id}`)
      .send({ documents: [{ type: 'GST_CERT', payload: { legal_name: 'Sunrise Bakery' } }] })
      .expect(200);
    await drain();
    const dto = await get(id);
    expect(dto.status).toBe('NEEDS_INFO');
    expect(dto.audit_log.at(-1)!.detail).toMatchObject({ missing: ['GST_CERT.gstin'] });
  });

  it('a PATCH that changes nothing does not move the application', async () => {
    const s = sample('missing.json');
    const id = await submit(s);
    await drain();
    const res = await request(app).patch(`/applications/${id}`).send({ pan: s.pan });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('NEEDS_INFO');
    expect(jobsOf(id)).toHaveLength(1);
  });

  it('documents are rejected (409) outside NEEDS_INFO', async () => {
    const id = await submit(sample('happy.json'));
    const res = await request(app).patch(`/applications/${id}`).send({ documents: [gstCert] });
    expect(res.status).toBe(409);
    expect(db.select().from(applications).where(eq(applications.id, id)).get()!.status).toBe('SUBMITTED');
  });

  it('form edits outside NEEDS_INFO still only audit APPLICATION_UPDATED', async () => {
    const id = await submit(sample('conflict.json'));
    await drain();
    const res = await request(app).patch(`/applications/${id}`).send({ merchant_name: 'Ramesh Electricals Pvt Ltd' });
    expect(res.body).toMatchObject({ status: 'IN_REVIEW' });
    expect(res.body.audit_log.at(-1)).toMatchObject({ event: 'APPLICATION_UPDATED', to_state: null });
  });
});

describe('missing-info requests for the merchant', () => {
  it('NEEDS_INFO carries plain-language requests and what to offer in the panel', async () => {
    const id = await submit(sample('missing.json'));
    await drain();
    expect((await get(id)).audit_log.at(-1)).toMatchObject({
      event: 'INFO_REQUIRED',
      detail: {
        reason: 'MISSING_INFO',
        requests: [{ code: 'MISSING_DOCUMENT', document: 'GST_CERT', message: 'GST certificate required.' }],
        form_fields: [],
        documents: ['GST_CERT'],
      },
    });
  });
});
