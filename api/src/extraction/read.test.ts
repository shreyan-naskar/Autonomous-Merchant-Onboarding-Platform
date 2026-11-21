import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OcrEngine } from './ocr.js';
import { readUploadedDocuments, valueConfidence, type ReadableDocument } from './read.js';
import { PDF_TEXT_CONFIDENCE } from './read.js';
import { fakeOcr, positionedPdf, textPdf, TWO_COLUMN_BANK_PDF_ITEMS } from './testkit.js';
import { SAMPLE_DIR } from '../testing.js';

const FILES: Record<string, Buffer> = {
  '/u/sharp.png': readFileSync(join(SAMPLE_DIR, 'pan-sharp.png')),
  '/u/blurry.png': readFileSync(join(SAMPLE_DIR, 'pan-blurry.png')),
  '/u/corrupt.jpg': Buffer.from('definitely not a jpeg'),
  '/u/gst.pdf': readFileSync(join(SAMPLE_DIR, 'gst-cert.pdf')),
  '/u/bank.PDF': readFileSync(join(SAMPLE_DIR, 'bank-proof.pdf')),
  '/u/scanned.pdf': textPdf([]),
  '/u/corrupt.pdf': Buffer.from('%PDF-1.4 truncated'),
  '/u/two-column.pdf': positionedPdf(TWO_COLUMN_BANK_PDF_ITEMS),
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
      [doc(1, null, { payload: { pan: 'X' } }), doc(2, '/u/notes.txt'), doc(3, '/u/sharp.png', { type: 'SELFIE' })],
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

describe('readUploadedDocuments: PDFs (text layer)', () => {
  const opts = () => ({ ocr: fakeOcr(), blurThreshold: 30, readFile });

  it('GST certificate PDF: GSTIN and legal name at PDF_TEXT_CONFIDENCE, no OCR, no blur check', async () => {
    const deps = opts();
    const r = (await readUploadedDocuments([doc(1, '/u/gst.pdf', { type: 'GST_CERT' })], deps)).get(1)!;
    expect(r).toEqual({
      source: 'pdf',
      payload: { gstin: '27AAFCS4321M1Z5', legal_name: 'Sunrise Traders Pvt Ltd' },
      confidence: PDF_TEXT_CONFIDENCE,
    });
    expect(deps.ocr.calls).toBe(0);
  });

  it('bank proof PDF (upper-case extension): grouped account number, IFSC, holder', async () => {
    const r = (await readUploadedDocuments([doc(1, '/u/bank.PDF', { type: 'BANK_PROOF' })], opts())).get(1)!;
    expect(r.payload).toEqual({ account_number: '60200987654321', ifsc: 'ICIC0004321', account_holder: 'Sunrise Traders Pvt Ltd' });
  });

  it('a PDF without a text layer (scanned) is unreadable: no_text_layer', async () => {
    const r = (await readUploadedDocuments([doc(1, '/u/scanned.pdf')], opts())).get(1)!;
    expect(r).toEqual({ source: 'pdf', payload: null, confidence: 0, error: 'no_text_layer' });
  });

  it('a corrupt PDF is unreadable (not retried): not_a_pdf', async () => {
    const r = (await readUploadedDocuments([doc(1, '/u/corrupt.pdf')], opts())).get(1)!;
    expect(r).toEqual({ source: 'pdf', payload: null, confidence: 0, error: 'not_a_pdf' });
  });
});

describe('field confidence from OCR words (not the page mean)', () => {
  it('a real card scores 0.37 overall but its PAN and name words 0.90 / 0.92: fields get their own', async () => {
    const words = [
      { text: 'INCOME', confidence: 0.3 },
      { text: 'AAFCS4321M', confidence: 0.9 },
      { text: 'SUNRISE', confidence: 0.95 },
      { text: 'TRADERS', confidence: 0.92 },
      { text: 'PVT', confidence: 0.97 },
      { text: 'LTD', confidence: 0.96 },
    ];
    const r = (await readUploadedDocuments([doc(1, '/u/sharp.png')], { ocr: fakeOcr(undefined, 0.37, words), blurThreshold: 30, readFile })).get(1)!;
    expect(r.confidence).toBe(0.37);
    expect(r.fieldConfidence).toEqual({ pan: 0.9, name: 0.92 });
  });

  it('valueConfidence: lowest word wins; best match per word; O and 0 compare equal; unknown word -> fallback', () => {
    const words = [
      { text: 'RAVI', confidence: 0.9 },
      { text: 'KUMAR', confidence: 0.6 },
      { text: 'KUMAR', confidence: 0.85 },
      { text: 'HDFCO001234', confidence: 0.8 },
    ];
    expect(valueConfidence('RAVI KUMAR', words, 0.3)).toBe(0.85);
    expect(valueConfidence('HDFC0001234', words, 0.3)).toBe(0.8);
    expect(valueConfidence('RAVI SHARMA', words, 0.3)).toBe(0.3);
  });

  it('without word data the page confidence is used (no fieldConfidence)', async () => {
    const r = (await readUploadedDocuments([doc(1, '/u/sharp.png')], { ocr: fakeOcr(), blurThreshold: 30, readFile })).get(1)!;
    expect(r.fieldConfidence).toBeUndefined();
    expect(r.confidence).toBe(0.94);
  });
});

describe('two-column bank statement PDF (labels drawn before values)', () => {
  it('rows rebuilt by position: account number, IFSC (O -> 0) and holder all found', async () => {
    const r = (await readUploadedDocuments([doc(1, '/u/two-column.pdf', { type: 'BANK_PROOF' })], { ocr: fakeOcr(), blurThreshold: 30, readFile })).get(1)!;
    expect(r.payload).toEqual({ account_number: '50100234567891', ifsc: 'HDFC0001234', account_holder: 'RAVI KUMAR' });
  });
});
