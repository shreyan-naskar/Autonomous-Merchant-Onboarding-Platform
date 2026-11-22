import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationDetailDtoSchema, DeadJobListDtoSchema } from '@app/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb, type Db } from './db/client.js';
import { fakeOcr } from './extraction/testkit.js';
import { createJobHandlers } from './jobs/handlers.js';
import { runDueJobsOnce, type WorkerDeps } from './jobs/worker.js';
import { createLogger } from './logger.js';
import { OCR_MODEL_FILE, OCR_MODEL_UNAVAILABLE, OcrModelUnavailableError, withOcrModelCheck } from './ocr-model.js';
import { createFakeProviderClient } from './providers/fake.js';
import { SAMPLE_DIR } from './testing.js';

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'ocr-cache-'));
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

const IMAGE = Buffer.from('png');
const failing = (message = 'TypeError: fetch failed') => ({
  calls: 0,
  async recognize(): Promise<never> {
    this.calls++;
    throw new Error(message);
  },
  async terminate() {},
});
const cacheModel = () => writeFileSync(join(cacheDir, OCR_MODEL_FILE), 'model');

describe('withOcrModelCheck', () => {
  it('model not cached and the download unreachable: a plain error, and tesseract is never started', async () => {
    const engine = failing();
    const ocr = withOcrModelCheck(engine, { cacheDir, reachable: async () => false });
    await expect(ocr.recognize(IMAGE)).rejects.toThrow(OcrModelUnavailableError);
    await expect(ocr.recognize(IMAGE)).rejects.toThrow(/^OCR model unavailable: /);
    expect(engine.calls).toBe(0);
  });

  it('model not cached, download reachable: tesseract downloads it as before; a failure while still uncached is reported the same way', async () => {
    const ok = fakeOcr('PAN AAFCS4321M');
    expect((await withOcrModelCheck(ok, { cacheDir, reachable: async () => true }).recognize(IMAGE)).text).toBe('PAN AAFCS4321M');
    const engine = failing();
    const err = await withOcrModelCheck(engine, { cacheDir, reachable: async () => true }).recognize(IMAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OcrModelUnavailableError);
    expect((err as Error).cause).toEqual(new Error('TypeError: fetch failed'));
  });

  it('model cached: no download check, and other OCR errors pass through unchanged', async () => {
    cacheModel();
    let checked = 0;
    const reachable = async () => (checked++, false);
    expect((await withOcrModelCheck(fakeOcr('text'), { cacheDir, reachable }).recognize(IMAGE)).text).toBe('text');
    await expect(withOcrModelCheck(failing('engine broke'), { cacheDir, reachable }).recognize(IMAGE)).rejects.toThrow('engine broke');
    expect(checked).toBe(0);
  });
});

describe('an uploaded image with no OCR model: the dead letter and review task say why', () => {
  let db: Db;
  let uploadDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    uploadDir = mkdtempSync(join(tmpdir(), 'ocr-uploads-'));
  });
  afterEach(() => {
    db.$client.close();
    rmSync(uploadDir, { recursive: true, force: true });
  });

  it('extract retries, then dead-letters with "OCR model unavailable" in the error and the JOB_DEAD note', async () => {
    let clock = 1_700_000_000_000;
    const config = loadConfig({ DB_PATH: ':memory:', UPLOAD_DIR: uploadDir });
    const logger = createLogger({ level: 'silent' });
    const app = createApp({ config, logger, db, now: () => clock });
    const ocr = withOcrModelCheck(failing(), { cacheDir, reachable: async () => false });
    const worker: WorkerDeps = { db, config, logger, handlers: createJobHandlers({ providers: createFakeProviderClient(), ocr }) };

    const form = JSON.parse(readFileSync(join(SAMPLE_DIR, 'ocr-pan.json'), 'utf8'));
    const res = await request(app)
      .post('/applications')
      .field('merchant_name', form.merchant_name)
      .field('pan', form.pan)
      .field('gst', form.gst)
      .field('bank_account', form.bank_account)
      .field('ifsc', form.ifsc)
      .field('documents', JSON.stringify(form.documents))
      .attach('PAN_CARD', readFileSync(join(SAMPLE_DIR, 'pan-sharp.png')), { filename: 'pan.png', contentType: 'image/png' })
      .expect(201);

    for (let i = 0; i < 20; i++) {
      clock += 60_000;
      await runDueJobsOnce(worker, clock);
    }
    const dead = DeadJobListDtoSchema.parse((await request(app).get('/jobs?status=dead')).body).items;
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ type: 'extract', application_id: res.body.id, last_error: OCR_MODEL_UNAVAILABLE });
    const d = ApplicationDetailDtoSchema.parse((await request(app).get(`/applications/${res.body.id}`)).body);
    const task = d.review_tasks.find((t) => t.reason === 'JOB_DEAD');
    expect(task?.note).toContain(OCR_MODEL_UNAVAILABLE);
  });
});
