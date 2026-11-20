import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationDetailDtoSchema, type ApplicationDetailDto } from '@app/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { createJobHandlers } from '../jobs/handlers.js';
import { runDueJobsOnce, type WorkerDeps } from '../jobs/worker.js';
import { createLogger } from '../logger.js';
import { createFakeProviderClient } from '../providers/fake.js';
import { createTesseractOcr } from './ocr.js';
import { fakeOcr, PAN_SHARP_OCR_TEXT } from './testkit.js';

/*
 * Phase 7.1 end to end: upload a PAN card image over HTTP, let the worker's
 * extract job run the blur check and OCR, and check where the app lands.
 */

const SAMPLE_DIR = fileURLToPath(new URL('../../../sample-data/', import.meta.url));
const form = JSON.parse(readFileSync(join(SAMPLE_DIR, 'ocr-pan.json'), 'utf8'));
const image = (name: string) => readFileSync(join(SAMPLE_DIR, name));

const T0 = 1_700_000_000_000;
let clock: number;
let db: Db;
let uploadDir: string;
let app: ReturnType<typeof createApp>;
let ocr: ReturnType<typeof fakeOcr>;
let worker: WorkerDeps;

beforeEach(() => {
  clock = T0;
  db = openDb(':memory:');
  uploadDir = mkdtempSync(join(tmpdir(), 'ocr-uploads-'));
  const config = loadConfig({ DB_PATH: ':memory:', UPLOAD_DIR: uploadDir });
  const logger = createLogger({ level: 'silent' });
  app = createApp({ config, logger, db, now: () => clock });
  ocr = fakeOcr();
  worker = { db, config, logger, handlers: createJobHandlers({ providers: createFakeProviderClient(), ocr }) };
});
afterEach(() => {
  db.$client.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

async function drain(maxTicks = 10) {
  for (let i = 0; i < maxTicks; i++) {
    clock += 1_000;
    if ((await runDueJobsOnce(worker, clock)).claimed === 0) return;
  }
  throw new Error('worker did not go idle');
}

async function submitWithPanImage(file: string, overrides: Record<string, string> = {}): Promise<string> {
  const fields = { ...form, ...overrides };
  const res = await request(app)
    .post('/applications')
    .field('merchant_name', fields.merchant_name)
    .field('pan', fields.pan)
    .field('gst', fields.gst)
    .field('bank_account', fields.bank_account)
    .field('ifsc', fields.ifsc)
    .field('documents', JSON.stringify(form.documents))
    .attach('PAN_CARD', image(file), { filename: file, contentType: 'image/png' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function get(id: string): Promise<ApplicationDetailDto> {
  const res = await request(app).get(`/applications/${id}`);
  return ApplicationDetailDtoSchema.parse(res.body);
}

describe('uploaded PAN card image', () => {
  it('OCR never runs in the request: the app is SUBMITTED with a queued extract job', async () => {
    const id = await submitWithPanImage('pan-sharp.png');
    expect(ocr.calls).toBe(0);
    const dto = await get(id);
    expect(dto.status).toBe('SUBMITTED');
    expect(dto.documents.find((d) => d.type === 'PAN_CARD')!.blur_score).toBeNull();
    expect(db.select().from(jobs).all().map((j) => [j.type, j.status])).toEqual([['extract', 'queued']]);
  });

  it('blurry image -> IN_REVIEW BLURRY_DOCUMENT with the score stored and no OCR', async () => {
    const id = await submitWithPanImage('pan-blurry.png');
    await drain();
    const dto = await get(id);

    expect(ocr.calls).toBe(0);
    expect(dto.status).toBe('IN_REVIEW');
    const pan = dto.documents.find((d) => d.type === 'PAN_CARD')!;
    expect(pan.blur_score).toBeLessThan(30);
    expect(dto.review_tasks).toHaveLength(1);
    expect(dto.review_tasks[0]).toMatchObject({ reason: 'BLURRY_DOCUMENT', status: 'OPEN' });
    expect(dto.review_tasks[0]!.note).toMatch(/PAN_CARD \(blur score [\d.]+ < threshold 30\)/);
    expect(dto.audit_log.at(-1)).toMatchObject({
      from_state: 'EXTRACTING',
      to_state: 'IN_REVIEW',
      event: 'BLURRY_DOCUMENT',
      detail: { reason: 'BLURRY_DOCUMENT', blur_threshold: 30, blurry: [{ document: 'PAN_CARD', blur_score: pan.blur_score }] },
    });
    expect(dto.extracted_fields.filter((f) => f.document_id === pan.id).map((f) => f.validation_status)).toEqual([
      'low_confidence',
      'low_confidence',
    ]);
  });

  it('sharp image, OCR matches the form -> VERIFYING with OCR confidence on the fields', async () => {
    const id = await submitWithPanImage('pan-sharp.png');
    await drain();
    const dto = await get(id);

    expect(ocr.calls).toBe(1);
    expect(dto.status).toBe('VERIFYING');
    const pan = dto.documents.find((d) => d.type === 'PAN_CARD')!;
    expect(pan.blur_score).toBeGreaterThan(30);
    const panFields = dto.extracted_fields.filter((f) => f.document_id === pan.id);
    expect(panFields.map((f) => [f.field, f.validation_status, f.confidence])).toEqual([
      ['pan', 'ok', 0.94],
      ['name', 'ok', 0.94],
    ]);
    // Read from an image, still masked in the response.
    expect(panFields[0]!.value).toBe('******321M');
  });

  it('OCR PAN conflicts with the form PAN -> IN_REVIEW DOC_CONFLICT', async () => {
    // Form says a different (valid) PAN; the GSTIN must embed it to isolate the PAN conflict.
    const id = await submitWithPanImage('pan-sharp.png', { pan: 'AAFCS9999M', gst: '27AAFCS9999M1Z5' });
    await drain();
    const dto = await get(id);
    expect(dto.status).toBe('IN_REVIEW');
    expect(dto.review_tasks[0]).toMatchObject({ reason: 'DOC_CONFLICT' });
    expect(dto.review_tasks[0]!.note).toContain('PAN_CARD.pan (differs_from_form');
  });

  it('low OCR confidence -> IN_REVIEW LOW_CONFIDENCE', async () => {
    worker = { ...worker, handlers: createJobHandlers({ providers: createFakeProviderClient(), ocr: fakeOcr(PAN_SHARP_OCR_TEXT, 0.55) }) };
    const id = await submitWithPanImage('pan-sharp.png');
    await drain();
    const dto = await get(id);
    expect(dto.status).toBe('IN_REVIEW');
    expect(dto.review_tasks[0]).toMatchObject({ reason: 'LOW_CONFIDENCE' });
  });

  it('an OCR outage fails the extract job (retried), leaving the app in EXTRACTING', async () => {
    const failing = { recognize: () => Promise.reject(new Error('model download failed')), terminate: async () => {} };
    worker = { ...worker, handlers: createJobHandlers({ providers: createFakeProviderClient(), ocr: failing }) };
    const id = await submitWithPanImage('pan-sharp.png');
    clock += 1_000;
    await runDueJobsOnce(worker, clock);
    expect((await get(id)).status).toBe('EXTRACTING');
    expect(db.select().from(jobs).all()[0]).toMatchObject({ type: 'extract', status: 'queued', attempts: 1 });
  });
});

// The real engine needs the English model (downloaded once into OCR_CACHE_DIR).
// Runs when the model is cached locally or OCR_E2E=1 allows the download.
const cacheDir = resolve(fileURLToPath(new URL('../../', import.meta.url)), loadConfig({}).ocrCacheDir);
const haveModel = existsSync(join(cacheDir, 'eng.traineddata')) || process.env.OCR_E2E === '1';

describe.runIf(haveModel)('tesseract.js on the sample image', () => {
  it('reads the PAN and name from pan-sharp.png', async () => {
    const engine = createTesseractOcr({ cacheDir });
    try {
      const { text, confidence } = await engine.recognize(image('pan-sharp.png'));
      expect(text).toContain('AAFCS4321M');
      expect(text).toContain('SUNRISE TRADERS PVT LTD');
      expect(confidence).toBeGreaterThan(0.8);
    } finally {
      await engine.terminate();
    }
  }, 60_000);
});
