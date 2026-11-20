import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ApplicationDetailDtoSchema, ApplicationListDtoSchema } from '@app/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/client.js';
import { applications, auditLog, documents, extractedFields, jobs, reviewTasks, verifications } from '../db/schema.js';
import { transition } from '../domain/transition.js';
import { createLogger } from '../logger.js';

const SAMPLE_DIR = fileURLToPath(new URL('../../../sample-data/', import.meta.url));
const sample = (name: string) => JSON.parse(readFileSync(join(SAMPLE_DIR, name), 'utf8'));
const SAMPLES = ['happy.json', 'gst-fail.json', 'conflict.json', 'missing.json'];

const happy = sample('happy.json');
const RAW = { pan: happy.pan as string, gst: happy.gst as string, acct: happy.bank_account as string };

const T0 = 1_700_000_000_000;
let clock = T0;
let db: Db;
let uploadDir: string;
let logs: string[];
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  clock = T0;
  db = openDb(':memory:');
  uploadDir = mkdtempSync(join(tmpdir(), 'uploads-'));
  logs = [];
  const stream = new Writable({
    write(c, _e, cb) {
      logs.push(c.toString());
      cb();
    },
  });
  app = createApp({
    config: loadConfig({ DB_PATH: ':memory:', UPLOAD_DIR: uploadDir }),
    logger: createLogger({ level: 'debug', stream }),
    db,
    now: () => clock,
  });
});
afterEach(() => {
  db.$client.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

/** Assert none of the raw sensitive values (or the PAN inside a GSTIN) appear in text. */
function expectNoRaw(text: string, values: string[]) {
  for (const v of values) expect(text, `raw value leaked`).not.toContain(v);
}

async function create(body: unknown = happy) {
  const res = await request(app).post('/applications').send(body as object);
  expect(res.status).toBe(201);
  return res;
}

describe('POST /applications (JSON) then GET /applications/:id', () => {
  it('creates in SUBMITTED with documents, one audit row and one queued extract job', async () => {
    const created = await create();
    const id = created.body.id as string;
    expect(created.headers.location).toBe(`/applications/${id}`);

    const res = await request(app).get(`/applications/${id}`);
    expect(res.status).toBe(200);
    const dto = ApplicationDetailDtoSchema.parse(res.body);

    expect(dto.status).toBe('SUBMITTED');
    expect(dto.merchant_name).toBe(happy.merchant_name);
    // Masked: last 4 only.
    expect(dto.pan).toBe('******234K');
    expect(dto.gst).toBe('***********K1Z5');
    expect(dto.bank_account).toBe('**********7891');
    expect(dto.ifsc).toBe('HDFC0001234');
    expect(dto.documents.map((d) => d.type)).toEqual(['PAN_CARD', 'GST_CERT', 'BANK_PROOF']);
    expect(dto.documents[0]!.payload).toEqual({ pan: '******234K', name: happy.merchant_name });
    expect(dto.documents[2]!.payload).toMatchObject({ account_number: '**********7891' });

    expect(dto.audit_log).toHaveLength(1);
    expect(dto.audit_log[0]).toMatchObject({
      actor: 'merchant',
      from_state: null,
      to_state: 'SUBMITTED',
      event: 'APPLICATION_SUBMITTED',
      detail: { via: 'json', document_types: ['PAN_CARD', 'GST_CERT', 'BANK_PROOF'] },
    });
    expect(db.select().from(auditLog).all()).toHaveLength(1);

    const queued = db.select().from(jobs).all();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: 'extract', status: 'queued', payload: { application_id: id }, runAt: T0 });

    // Raw values are stored (masking is a presentation concern).
    expect(db.select().from(applications).where(eq(applications.id, id)).get()!.pan).toBe(RAW.pan);
  });

  it('rolls back the application and documents if the extract job cannot be queued', async () => {
    db.$client.exec(`CREATE TRIGGER no_jobs BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'queue down'); END;`);
    const res = await request(app).post('/applications').send(happy);
    expect(res.status).toBe(500);
    expect(db.select().from(applications).all()).toHaveLength(0);
    expect(db.select().from(documents).all()).toHaveLength(0);
    expect(db.select().from(auditLog).all()).toHaveLength(0);
  });

  it('GET of an unknown id is 404', async () => {
    const res = await request(app).get('/applications/nope');
    expect(res.status).toBe(404);
  });
});

describe('no raw PAN / GSTIN / bank account in any response JSON', () => {
  it.each(SAMPLES)('%s: POST, GET detail and GET list are masked', async (file) => {
    const body = sample(file);
    const raw = [body.pan, body.gst, body.bank_account];
    const created = await create(body);
    const detail = await request(app).get(`/applications/${created.body.id}`);
    const list = await request(app).get('/applications');
    for (const res of [created, detail, list]) expectNoRaw(JSON.stringify(res.body), raw);
  });

  it('masks every section of a fully populated detail response, and the logs', async () => {
    const id = (await create()).body.id as string;
    const docId = db.select().from(documents).all()[0]!.id;

    // Populate every section with raw values the way later phases will.
    db.insert(extractedFields)
      .values([
        { applicationId: id, documentId: docId, field: 'pan', value: RAW.pan, confidence: 1, validationStatus: 'ok' },
        { applicationId: id, documentId: docId, field: 'gst', value: RAW.gst, confidence: 1, validationStatus: 'ok' },
        { applicationId: id, field: 'bank_account', value: RAW.acct, confidence: 1, validationStatus: 'ok' },
        { applicationId: id, field: 'name', value: happy.merchant_name, confidence: 1, validationStatus: 'ok' },
      ])
      .run();
    db.insert(verifications)
      .values({
        applicationId: id,
        kind: 'BANK',
        status: 'PASSED',
        bankVersion: 1,
        requestedAt: T0,
        rawResponse: { account_number: RAW.acct, pan: RAW.pan },
      })
      .run();
    db.insert(reviewTasks)
      .values({ applicationId: id, reason: 'DOC_CONFLICT', note: `PAN ${RAW.pan} vs acct ${RAW.acct}`, createdAt: T0 })
      .run();
    transition(db, id, 'EXTRACTING', {
      actor: 'system',
      event: 'EXTRACTION_STARTED',
      detail: { pan: RAW.pan, nested: { gstin: RAW.gst, list: [{ bank_account: RAW.acct }] }, msg: `saw ${RAW.pan}` },
      now: T0,
    });

    const res = await request(app).get(`/applications/${id}`);
    const dto = ApplicationDetailDtoSchema.parse(res.body);
    expect(dto.extracted_fields).toHaveLength(4);
    expect(dto.extracted_fields.find((f) => f.field === 'name')!.value).toBe(happy.merchant_name);
    expect(dto.verifications).toHaveLength(1);
    expect(dto.review_tasks).toHaveLength(1);
    expect(dto.audit_log).toHaveLength(2);
    expect(dto.open_review_count).toBe(1);

    expectNoRaw(res.text, [RAW.pan, RAW.gst, RAW.acct]);
    expectNoRaw(logs.join(''), [RAW.pan, RAW.gst, RAW.acct]);
  });
});

describe('validation errors', () => {
  it('returns 400 with Zod issues that do not echo PAN or account values', async () => {
    const badPan = 'AABCL1234KK';
    const badAcct = '5010023456789100000000';
    const res = await request(app)
      .post('/applications')
      .send({
        ...happy,
        pan: badPan,
        bank_account: badAcct,
        gst: `9${RAW.gst}`,
        [RAW.pan]: 'unknown key named like a PAN',
        documents: [{ type: 'AADHAAR', payload: { pan: RAW.pan } }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const paths = (res.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['pan', 'bank_account', 'gst', 'documents.0.type']));
    expectNoRaw(res.text, [badPan, badAcct, RAW.pan, RAW.gst, RAW.acct]);
    expectNoRaw(logs.join(''), [badPan, badAcct, RAW.pan, RAW.gst, RAW.acct]);
    expect(db.select().from(applications).all()).toHaveLength(0);
  });

  it('rejects duplicate document types and a missing merchant_name', async () => {
    const dup = await request(app)
      .post('/applications')
      .send({ ...happy, documents: [happy.documents[0], happy.documents[0]] });
    expect(dup.status).toBe(400);
    const noName = await request(app).post('/applications').send({ pan: RAW.pan });
    expect(noName.status).toBe(400);
    expect(noName.body.error.details[0].path).toBe('merchant_name');
  });
});

describe('POST /applications (multipart)', () => {
  const PDF = Buffer.from('%PDF-1.4\n% sample\n');

  it('saves uploaded files under the upload dir and stores the path on the document', async () => {
    const res = await request(app)
      .post('/applications')
      .field('merchant_name', happy.merchant_name)
      .field('pan', RAW.pan)
      .field('gst', RAW.gst)
      .field('bank_account', RAW.acct)
      .field('ifsc', '')
      .field('documents', JSON.stringify([happy.documents[1]]))
      .attach('PAN_CARD', PDF, { filename: 'my pan.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expectNoRaw(res.text, [RAW.pan, RAW.gst, RAW.acct]);

    const dto = ApplicationDetailDtoSchema.parse(res.body);
    expect(dto.ifsc).toBeNull();
    expect(dto.audit_log[0]!.detail).toMatchObject({ via: 'multipart' });
    const pan = dto.documents.find((d) => d.type === 'PAN_CARD')!;
    expect(pan.file_name).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(pan.payload).toBeNull();
    expect(dto.documents.find((d) => d.type === 'GST_CERT')!.payload).toMatchObject({ gstin: '***********K1Z5' });

    const row = db.select().from(documents).where(eq(documents.type, 'PAN_CARD')).get()!;
    expect(row.path).toBe(join(uploadDir, pan.file_name!));
    expect(readFileSync(row.path!)).toEqual(PDF);
    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  it('rejects an unsupported file type or unknown file part and leaves no file behind', async () => {
    const exe = await request(app)
      .post('/applications')
      .field('merchant_name', 'Acme')
      .attach('PAN_CARD', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/octet-stream' });
    expect(exe.status).toBe(400);

    const unknown = await request(app)
      .post('/applications')
      .field('merchant_name', 'Acme')
      .attach('SELFIE', PDF, { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('UPLOAD_REJECTED');

    expect(db.select().from(applications).all()).toHaveLength(0);
    expect(existsSync(uploadDir) ? readdirSync(uploadDir) : []).toEqual([]);
  });

  it('removes saved files when field validation fails', async () => {
    const res = await request(app)
      .post('/applications')
      .field('merchant_name', 'Acme')
      .field('pan', 'not-a-pan')
      .attach('PAN_CARD', PDF, { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(readdirSync(uploadDir)).toEqual([]);
  });

  it('rejects the same document type sent as both a file and a JSON document', async () => {
    const res = await request(app)
      .post('/applications')
      .field('merchant_name', 'Acme')
      .field('documents', JSON.stringify([happy.documents[0]]))
      .attach('PAN_CARD', PDF, { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(readdirSync(uploadDir)).toEqual([]);
  });
});

describe('GET /applications', () => {
  it('lists newest first with time in state and open review count', async () => {
    const a = (await create()).body.id as string;
    clock = T0 + 1_000;
    const b = (await create(sample('gst-fail.json'))).body.id as string;
    db.insert(reviewTasks)
      .values([
        { applicationId: a, reason: 'DOC_CONFLICT', createdAt: T0 },
        { applicationId: a, reason: 'LOW_CONFIDENCE', createdAt: T0 },
        { applicationId: a, reason: 'OLD', status: 'RESOLVED', createdAt: T0 },
      ])
      .run();

    clock = T0 + 61_000;
    const res = await request(app).get('/applications');
    expect(res.status).toBe(200);
    const list = ApplicationListDtoSchema.parse(res.body);
    expect(list.count).toBe(2);
    expect(list.items.map((i) => i.id)).toEqual([b, a]);
    expect(list.items[1]).toMatchObject({ time_in_state_ms: 61_000, open_review_count: 2, pan: '******234K' });
    expect(list.items[0]).toMatchObject({ time_in_state_ms: 60_000, open_review_count: 0 });
  });

  it('filters by status and validates the filter', async () => {
    const id = (await create()).body.id as string;
    await create(sample('missing.json'));
    transition(db, id, 'EXTRACTING', { actor: 'system', event: 'EXTRACTION_STARTED', now: T0 });

    const res = await request(app).get('/applications?status=EXTRACTING');
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([id]);
    expect((await request(app).get('/applications?status=BOGUS')).status).toBe(400);
    expect((await request(app).get('/applications?limit=0')).status).toBe(400);
  });
});

describe('PATCH /applications/:id', () => {
  it('persists merchant info and bank changes, masks them, audits field names only', async () => {
    const id = (await create()).body.id as string;
    clock = T0 + 5_000;
    const newAcct = '99988877766655';
    const res = await request(app)
      .patch(`/applications/${id}`)
      .send({ merchant_name: 'Lakshmi Textiles Ltd', bank_account: newAcct, ifsc: 'icic0009999' });
    expect(res.status).toBe(200);
    expectNoRaw(res.text, [newAcct, RAW.pan, RAW.gst]);

    const dto = ApplicationDetailDtoSchema.parse(res.body);
    expect(dto).toMatchObject({
      status: 'SUBMITTED',
      merchant_name: 'Lakshmi Textiles Ltd',
      bank_account: '**********6655',
      ifsc: 'ICIC0009999',
      bank_version: 1,
    });
    expect(dto.audit_log.at(-1)).toMatchObject({
      event: 'APPLICATION_UPDATED',
      actor: 'merchant',
      from_state: 'SUBMITTED',
      to_state: null,
      detail: { fields: ['merchant_name', 'bank_account', 'ifsc'] },
    });
    const row = db.select().from(applications).where(eq(applications.id, id)).get()!;
    expect(row).toMatchObject({ bankAccount: newAcct, updatedAt: T0 + 5_000, stateEnteredAt: T0 });
    expectNoRaw(logs.join(''), [newAcct]);
  });

  it('does not write an audit row when nothing changed', async () => {
    const id = (await create()).body.id as string;
    const res = await request(app).patch(`/applications/${id}`).send({ pan: RAW.pan.toLowerCase() });
    expect(res.status).toBe(200);
    expect(res.body.audit_log).toHaveLength(1);
  });

  it('validates the body without echoing values', async () => {
    const id = (await create()).body.id as string;
    const bad = '12AB';
    const empty = await request(app).patch(`/applications/${id}`).send({});
    expect(empty.status).toBe(400);
    const invalid = await request(app).patch(`/applications/${id}`).send({ bank_account: `${RAW.acct}${bad}` });
    expect(invalid.status).toBe(400);
    expectNoRaw(invalid.text, [RAW.acct]);
    const unknownKey = await request(app).patch(`/applications/${id}`).send({ status: 'APPROVED' });
    expect(unknownKey.status).toBe(400);
    expect(db.select().from(applications).get()!.status).toBe('SUBMITTED');
  });

  it('is 404 for an unknown id and 409 once the application is locked', async () => {
    expect((await request(app).patch('/applications/nope').send({ ifsc: 'HDFC0001234' })).status).toBe(404);

    const id = (await create()).body.id as string;
    db.$client.prepare(`UPDATE applications SET status = 'REJECTED' WHERE id = ?`).run(id); // test fixture
    const res = await request(app).patch(`/applications/${id}`).send({ bank_account: '123456789' });
    expect(res.status).toBe(409);
  });
});
