import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationDetailDtoSchema, type ApplicationDetailDto } from '@app/shared';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/client.js';
import { documents as documentsTable, jobs } from '../db/schema.js';
import { createJobHandlers } from '../jobs/handlers.js';
import { runDueJobsOnce, type WorkerDeps } from '../jobs/worker.js';
import { createLogger } from '../logger.js';
import { createFakeProviderClient } from '../providers/fake.js';
import { createTesseractOcr } from './ocr.js';
import { pdfPageImages } from './pdf.js';
import { readUploadedDocuments } from './read.js';
import { fakeOcr, PAN_SHARP_OCR_TEXT, scannedPdf, scriptedOcr, textPdf } from './testkit.js';
import { SAMPLE_DIR } from '../testing.js';

/* Uploaded images and PDFs, end to end: HTTP upload, then the worker's extract job (blur check, OCR, PDF text). */

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

  it('a WebP photo is accepted, stored as .webp and read like a PNG', async () => {
    const webp = await sharp(image('pan-sharp.png')).webp().toBuffer();
    const res = await request(app)
      .post('/applications')
      .field('merchant_name', form.merchant_name)
      .field('pan', form.pan)
      .field('gst', form.gst)
      .field('bank_account', form.bank_account)
      .field('ifsc', form.ifsc)
      .field('documents', JSON.stringify(form.documents))
      .attach('PAN_CARD', webp, { filename: 'pan.webp', contentType: 'image/webp' });
    expect(res.status).toBe(201);
    await drain();
    expect(readdirSync(uploadDir).some((f) => f.endsWith('.webp'))).toBe(true);
    expect(ocr.calls).toBe(1);
    expect((await get(res.body.id)).status).toBe('VERIFYING');
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

  it('low OCR confidence that no other pass confirms -> IN_REVIEW LOW_CONFIDENCE', async () => {
    // Only the first pass makes out the card; the others read nothing, so nothing agrees with it.
    const ocr = scriptedOcr([PAN_SHARP_OCR_TEXT, ''], 0.55);
    worker = { ...worker, handlers: createJobHandlers({ providers: createFakeProviderClient(), ocr }) };
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

describe('GET /applications/:id/documents/:documentId/file (the reviewer looks at the upload)', () => {
  const fileUrl = (id: string, docId: number | string) => `/applications/${id}/documents/${docId}/file`;

  it('serves the uploaded bytes with a fixed type, inline, never cached', async () => {
    const id = await submitWithPanImage('pan-sharp.png');
    const pan = (await get(id)).documents.find((d) => d.type === 'PAN_CARD')!;
    const res = await request(app).get(fileUrl(id, pan.id)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe('inline; filename="pan_card.png"');
    expect(Buffer.compare(res.body as Buffer, image('pan-sharp.png'))).toBe(0);
  });

  it('404 for a structured document, another application\'s document, a bad id, or a path outside the upload directory', async () => {
    const id = await submitWithPanImage('pan-sharp.png');
    const d = await get(id);
    const pan = d.documents.find((x) => x.type === 'PAN_CARD')!;
    const structured = d.documents.find((x) => x.file_name === null)!;
    const other = await submitWithPanImage('pan-sharp.png');

    expect((await request(app).get(fileUrl(id, structured.id))).status).toBe(404);
    expect((await request(app).get(fileUrl(other, pan.id))).status).toBe(404);
    expect((await request(app).get(fileUrl(id, 'abc'))).status).toBe(404);

    db.update(documentsTable).set({ path: join(uploadDir, '..', 'outside.png') }).where(eq(documentsTable.id, pan.id)).run();
    expect((await request(app).get(fileUrl(id, pan.id))).status).toBe(404);
  });
});

describe('uploaded PDF documents (text layer)', () => {
  /** ocr-pan.json form with every document uploaded as a file. */
  async function submitAllFiles(gstPdf: Buffer, overrides: Record<string, string> = {}): Promise<string> {
    const fields = { ...form, ...overrides };
    const res = await request(app)
      .post('/applications')
      .field('merchant_name', fields.merchant_name)
      .field('pan', fields.pan)
      .field('gst', fields.gst)
      .field('bank_account', fields.bank_account)
      .field('ifsc', fields.ifsc)
      .attach('PAN_CARD', image('pan-sharp.png'), { filename: 'pan.png', contentType: 'image/png' })
      .attach('GST_CERT', gstPdf, { filename: 'gst.pdf', contentType: 'application/pdf' })
      .attach('BANK_PROOF', image('bank-proof.pdf'), { filename: 'bank.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('PDFs feed the same extractors: all fields ok -> VERIFYING; PDF fields at 0.95, values masked', async () => {
    const id = await submitAllFiles(image('gst-cert.pdf'));
    await drain();
    const dto = await get(id);

    expect(dto.status).toBe('VERIFYING');
    expect(ocr.calls).toBe(1); // the PAN image only
    const byType = (t: string) => {
      const docId = dto.documents.find((d) => d.type === t)!.id;
      return dto.extracted_fields.filter((f) => f.document_id === docId).map((f) => [f.field, f.validation_status, f.confidence]);
    };
    expect(byType('GST_CERT')).toEqual([
      ['gst', 'ok', 0.95],
      ['legal_name', 'ok', 0.95],
    ]);
    expect(byType('BANK_PROOF')).toEqual([
      ['bank_account', 'ok', 0.95],
      ['ifsc', 'ok', 0.95],
      ['account_holder', 'ok', 0.95],
    ]);
    expect(JSON.stringify(dto)).not.toContain('60200987654321');
    expect(JSON.stringify(dto)).not.toContain('27AAFCS4321M1Z5');
    // PDFs have no blur score.
    expect(dto.documents.find((d) => d.type === 'GST_CERT')!.blur_score).toBeNull();
  });

  it('GSTIN in the PDF differs from the form -> IN_REVIEW DOC_CONFLICT', async () => {
    const other = textPdf(['Registration Number: 27AAFCS4321M2Z4', 'Legal Name: Sunrise Traders Pvt Ltd']);
    const id = await submitAllFiles(other);
    await drain();
    const dto = await get(id);
    expect(dto.status).toBe('IN_REVIEW');
    expect(dto.review_tasks[0]!.note).toContain('GST_CERT.gst (differs_from_form');
  });

  it('a blank PDF (no text layer, empty page) -> IN_REVIEW LOW_CONFIDENCE, explained as blank', async () => {
    const id = await submitAllFiles(textPdf([]));
    await drain();
    const dto = await get(id);
    expect(dto.status).toBe('IN_REVIEW');
    expect(dto.review_tasks[0]).toMatchObject({ reason: 'LOW_CONFIDENCE' });
    expect(dto.review_tasks[0]!.note).toMatch(/^GST certificate: the upload is blank\. /);
    expect(dto.review_tasks[0]!.note).toContain('GST_CERT.gst (blank');
  });
});

describe('supplying missing documents while NEEDS_INFO (multipart PATCH, as the browser panel sends it)', () => {
  const uploadsOnDisk = () => readdirSync(uploadDir);
  const docPath = (id: string, type: string) =>
    db.select().from(documentsTable).all().find((d) => d.applicationId === id && d.type === type)!.path;
  const png = (name: string) => [image(name), { filename: name, contentType: 'image/png' }] as const;

  /** ocr-pan.json's form with its GST + bank JSON documents, but no PAN card (and optionally no form PAN). */
  async function submitWithoutPanCard({ withPan = true } = {}): Promise<string> {
    let r = request(app).post('/applications').field('merchant_name', form.merchant_name);
    if (withPan) r = r.field('pan', form.pan);
    const res = await r
      .field('gst', form.gst)
      .field('bank_account', form.bank_account)
      .field('ifsc', form.ifsc)
      .field('documents', JSON.stringify(form.documents));
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('missing PAN card -> NEEDS_INFO asks for it -> uploaded image -> VERIFYING', async () => {
    const id = await submitWithoutPanCard();
    await drain();
    let dto = await get(id);
    expect(dto.status).toBe('NEEDS_INFO');
    expect(dto.audit_log.at(-1)).toMatchObject({
      event: 'INFO_REQUIRED',
      detail: { requests: [{ code: 'MISSING_DOCUMENT', document: 'PAN_CARD', message: 'PAN card required.' }], documents: ['PAN_CARD'] },
    });

    const res = await request(app).patch(`/applications/${id}`).attach('PAN_CARD', ...png('pan-sharp.png'));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('EXTRACTING');
    await drain();
    dto = await get(id);
    expect(dto.status).toBe('VERIFYING');
    expect(ocr.calls).toBe(1);
  });

  it('missing form PAN and PAN card supplied together (fields + file in one PATCH; empty inputs ignored)', async () => {
    const id = await submitWithoutPanCard({ withPan: false });
    await drain();
    expect((await get(id)).audit_log.at(-1)!.detail).toMatchObject({ form_fields: ['pan'], documents: ['PAN_CARD'] });
    const res = await request(app).patch(`/applications/${id}`).field('pan', form.pan).field('ifsc', '').attach('PAN_CARD', ...png('pan-sharp.png'));
    expect(res.status).toBe(200);
    await drain();
    expect((await get(id)).status).toBe('VERIFYING');
  });

  it('a blurry image supplied in NEEDS_INFO is an exception for a reviewer (IN_REVIEW BLURRY_DOCUMENT)', async () => {
    const id = await submitWithoutPanCard();
    await drain();
    await request(app).patch(`/applications/${id}`).attach('PAN_CARD', ...png('pan-blurry.png')).expect(200);
    await drain();
    const dto = await get(id);
    expect(dto.status).toBe('IN_REVIEW');
    expect(dto.review_tasks[0]).toMatchObject({ reason: 'BLURRY_DOCUMENT' });
  });

  it('a replaced upload is deleted from disk', async () => {
    // PAN card uploaded, bank proof missing -> NEEDS_INFO; the merchant sends both again.
    const res0 = await request(app)
      .post('/applications')
      .field('merchant_name', form.merchant_name)
      .field('pan', form.pan)
      .field('gst', form.gst)
      .field('bank_account', form.bank_account)
      .field('ifsc', form.ifsc)
      .field('documents', JSON.stringify(form.documents.filter((d: { type: string }) => d.type !== 'BANK_PROOF')))
      .attach('PAN_CARD', ...png('pan-sharp.png'));
    const id = res0.body.id as string;
    await drain();
    expect((await get(id)).status).toBe('NEEDS_INFO');
    const oldPath = docPath(id, 'PAN_CARD')!;
    expect(uploadsOnDisk()).toHaveLength(1);

    await request(app)
      .patch(`/applications/${id}`)
      .attach('PAN_CARD', ...png('pan-sharp.png'))
      .attach('BANK_PROOF', image('bank-proof.pdf'), { filename: 'bank.pdf', contentType: 'application/pdf' })
      .expect(200);
    expect(existsSync(oldPath)).toBe(false);
    expect(uploadsOnDisk()).toHaveLength(2);
    await drain();
    expect((await get(id)).status).toBe('VERIFYING');
  });

  it('files are refused (409) outside NEEDS_INFO, and the uploaded file is removed', async () => {
    const id = await submitWithPanImage('pan-sharp.png');
    await drain(); // VERIFYING
    const before = uploadsOnDisk();
    const res = await request(app).patch(`/applications/${id}`).attach('PAN_CARD', ...png('pan-sharp.png'));
    expect(res.status).toBe(409);
    expect(uploadsOnDisk()).toEqual(before);
  });

  it('400 for an empty multipart PATCH, and for an unsupported file type', async () => {
    const id = await submitWithoutPanCard();
    await drain();
    await request(app).patch(`/applications/${id}`).field('ifsc', '').expect(400);
    await request(app)
      .patch(`/applications/${id}`)
      .attach('PAN_CARD', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/octet-stream' })
      .expect(400);
    expect(uploadsOnDisk()).toHaveLength(0);
  });
});

describe('demo samples', () => {
  const json = (name: string) => JSON.parse(readFileSync(join(SAMPLE_DIR, name), 'utf8'));

  it('missing.json -> NEEDS_INFO; uploading missing-gst-cert.pdf in the panel -> VERIFYING', async () => {
    const res = await request(app).post('/applications').send(json('missing.json')).expect(201);
    const id = res.body.id as string;
    await drain();
    expect((await get(id)).status).toBe('NEEDS_INFO');
    await request(app)
      .patch(`/applications/${id}`)
      .attach('GST_CERT', image('missing-gst-cert.pdf'), { filename: 'gst.pdf', contentType: 'application/pdf' })
      .expect(200);
    await drain();
    const dto = await get(id);
    expect(dto.status).toBe('VERIFYING');
    const gstDoc = dto.documents.find((d) => d.type === 'GST_CERT')!;
    expect(dto.extracted_fields.filter((f) => f.document_id === gstDoc.id).map((f) => [f.field, f.validation_status])).toEqual([
      ['gst', 'ok'],
      ['legal_name', 'ok'],
    ]);
  });

  it('low-confidence.json (an invalid IFSC on the bank proof) -> IN_REVIEW LOW_CONFIDENCE', async () => {
    const res = await request(app).post('/applications').send(json('low-confidence.json')).expect(201);
    await drain();
    const dto = await get(res.body.id);
    expect(dto.status).toBe('IN_REVIEW');
    expect(dto.review_tasks.map((t) => t.reason)).toEqual(['LOW_CONFIDENCE']);
    expect(dto.review_tasks[0]!.note).toContain('BANK_PROOF.ifsc (invalid_format, confidence 0.5)');
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

  it('reads the PAN and name from the same card scanned into a PDF with no text layer, under a block-mode pass too', async () => {
    const engine = createTesseractOcr({ cacheDir });
    try {
      const png = image('pan-sharp.png');
      const meta = await sharp(png).metadata();
      const jpeg = await sharp(png).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
      const pdf = scannedPdf(jpeg, { width: meta.width!, height: meta.height! }, { widthPt: 300 });
      const r = (
        await readUploadedDocuments([{ id: 1, type: 'PAN_CARD', payload: null, path: 'scan.pdf' }], {
          ocr: engine,
          blurThreshold: loadConfig({}).thresholds.blur,
          readFile: async () => pdf,
        })
      ).get(1)!;
      expect(r.payload).toEqual({ pan: 'AAFCS4321M', name: 'SUNRISE TRADERS PVT LTD' });
      expect(r.fieldConfidence!.pan).toBeGreaterThan(0.8);
      expect((await engine.recognize(png, 'block')).text).toContain('AAFCS4321M');
    } finally {
      await engine.terminate();
    }
  }, 120_000);
});

/* Photos as people really take them, read by the real engine (calibration for image.ts and read.ts). */
describe.runIf(haveModel)('tesseract.js on awkward photos of the sample card', () => {
  const card = image('pan-sharp.png');
  const readAs = async (engine: ReturnType<typeof createTesseractOcr>, type: string, file: Buffer, path = 'photo.png') =>
    (
      await readUploadedDocuments([{ id: 1, type, payload: null, path }], {
        ocr: engine,
        blurThreshold: loadConfig({}).thresholds.blur,
        readFile: async () => file,
      })
    ).get(1)!;

  it('upside down, tilted 4 and 10 degrees, and small on a dark desk: all read in full', async () => {
    const engine = createTesseractOcr({ cacheDir });
    try {
      const meta = await sharp(card).metadata();
      const small = await sharp(card).resize(Math.round(meta.width! * 0.6)).toBuffer();
      const desk = await sharp({ create: { width: 1100, height: 800, channels: 3, background: '#6b5a48' } })
        .composite([{ input: small, left: 180, top: 120 }])
        .jpeg({ quality: 70 })
        .toBuffer();
      for (const photo of [
        await sharp(card).rotate(180).png().toBuffer(),
        await sharp(card).rotate(4, { background: '#ffffff' }).png().toBuffer(),
        await sharp(card).rotate(10, { background: '#ffffff' }).png().toBuffer(),
        desk,
      ]) {
        const r = await readAs(engine, 'PAN_CARD', photo);
        expect(r.payload).toEqual({ pan: 'AAFCS4321M', name: 'SUNRISE TRADERS PVT LTD' });
      }
    } finally {
      await engine.terminate();
    }
  }, 180_000);

  it('the GST certificate scanned small: the GSTIN OCR splits ("27AAFCS4321 M1 Z5") is still found', async () => {
    const engine = createTesseractOcr({ cacheDir });
    try {
      const [page] = await pdfPageImages(readFileSync(join(SAMPLE_DIR, 'gst-cert.pdf')), 1);
      const scan = await sharp(page!).resize(1000).jpeg({ quality: 60 }).toBuffer();
      const r = await readAs(engine, 'GST_CERT', scan, 'scan.jpg');
      expect(r.payload).toMatchObject({ gstin: '27AAFCS4321M1Z5', legal_name: 'Sunrise Traders Pvt Ltd' });
    } finally {
      await engine.terminate();
    }
  }, 120_000);

  it('a GST certificate uploaded as the PAN card is recognised as one', async () => {
    const engine = createTesseractOcr({ cacheDir });
    try {
      const r = await readAs(engine, 'PAN_CARD', readFileSync(join(SAMPLE_DIR, 'gst-cert.pdf')), 'gst.pdf');
      expect(r.payload).not.toHaveProperty('pan');
      expect(r.looksLike).toBe('GST_CERT');
    } finally {
      await engine.terminate();
    }
  }, 120_000);
});

