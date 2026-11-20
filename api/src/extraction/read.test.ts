import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { OcrEngine } from './ocr.js';
import { readUploadedDocuments, type ReadableDocument } from './read.js';
import { fakeOcr } from './testkit.js';

const SAMPLE_DIR = fileURLToPath(new URL('../../../sample-data/', import.meta.url));
const FILES: Record<string, Buffer> = {
  '/u/sharp.png': readFileSync(join(SAMPLE_DIR, 'pan-sharp.png')),
  '/u/blurry.png': readFileSync(join(SAMPLE_DIR, 'pan-blurry.png')),
  '/u/corrupt.jpg': Buffer.from('definitely not a jpeg'),
};
const readFile = async (p: string) => {
  const f = FILES[p];
  if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return f;
};

const doc = (id: number, path: string | null, extra: Partial<ReadableDocument> = {}): ReadableDocument => ({
  id,
  type: 'PAN_CARD',
  payload: null,
  path,
  ...extra,
});

describe('readUploadedDocuments', () => {
  it('sharp image: blur check passes, OCR runs, payload parsed with OCR confidence', async () => {
    const ocr = fakeOcr();
    const out = await readUploadedDocuments([doc(1, '/u/sharp.png')], { ocr, blurThreshold: 30, readFile });
    const r = out.get(1)!;
    expect(r).toMatchObject({ source: 'ocr', blurry: false, confidence: 0.94, payload: { pan: 'AAFCS4321M', name: 'SUNRISE TRADERS PVT LTD' } });
    expect(r.blurScore).toBeGreaterThan(30);
    expect(ocr.calls).toBe(1);
  });

  it('blurry image: flagged with its score and never sent to OCR', async () => {
    const ocr = fakeOcr();
    const r = (await readUploadedDocuments([doc(1, '/u/blurry.png')], { ocr, blurThreshold: 30, readFile })).get(1)!;
    expect(r).toMatchObject({ blurry: true, payload: null, confidence: 0 });
    expect(r.blurScore).toBeLessThan(30);
    expect(ocr.calls).toBe(0);
  });

  it('the threshold comes from the caller (config)', async () => {
    const r = (await readUploadedDocuments([doc(1, '/u/sharp.png')], { ocr: fakeOcr(), blurThreshold: 1e6, readFile })).get(1)!;
    expect(r.blurry).toBe(true);
  });

  it('corrupt image and missing file are unreadable, not retried', async () => {
    const ocr = fakeOcr();
    const out = await readUploadedDocuments([doc(1, '/u/corrupt.jpg'), doc(2, '/u/gone.png')], { ocr, blurThreshold: 30, readFile });
    expect(out.get(1)).toEqual({ source: 'ocr', payload: null, confidence: 0, error: 'not_an_image' });
    expect(out.get(2)).toEqual({ source: 'ocr', payload: null, confidence: 0, error: 'file_unreadable' });
    expect(ocr.calls).toBe(0);
  });

  it('skips structured documents, non-image uploads and unknown types', async () => {
    const out = await readUploadedDocuments(
      [doc(1, null, { payload: { pan: 'X' } }), doc(2, '/u/scan.pdf'), doc(3, '/u/sharp.png', { type: 'SELFIE' })],
      { ocr: fakeOcr(), blurThreshold: 30, readFile },
    );
    expect(out.size).toBe(0);
  });

  it('an OCR engine failure propagates (the worker retries the job)', async () => {
    const ocr: OcrEngine = { recognize: () => Promise.reject(new Error('model download failed')), terminate: async () => {} };
    await expect(readUploadedDocuments([doc(1, '/u/sharp.png')], { ocr, blurThreshold: 30, readFile })).rejects.toThrow(
      'model download failed',
    );
  });
});
