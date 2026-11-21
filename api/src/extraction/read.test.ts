import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OcrEngine } from './ocr.js';
import { pdfPageImages } from './pdf.js';
import { PDF_TEXT_CONFIDENCE, readUploadedDocuments, valueConfidence, type ReadableDocument } from './read.js';
import { fakeOcr, PAN_SHARP_OCR_TEXT, positionedPdf, scannedPdf, scriptedOcr, textPdf, TWO_COLUMN_BANK_PDF_ITEMS } from './testkit.js';
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

  it('a blank PDF (no text layer, nothing on the page) is unreadable without OCR: no_text_layer', async () => {
    const deps = opts();
    const r = (await readUploadedDocuments([doc(1, '/u/scanned.pdf')], deps)).get(1)!;
    expect(r).toEqual({ source: 'pdf', payload: null, confidence: 0, error: 'no_text_layer' });
    expect(deps.ocr.calls).toBe(0);
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

  it('without word data each field gets the page confidence', async () => {
    const r = (await readUploadedDocuments([doc(1, '/u/sharp.png')], { ocr: fakeOcr(), blurThreshold: 30, readFile })).get(1)!;
    expect(r.fieldConfidence).toEqual({ pan: 0.94, name: 0.94 });
    expect(r.confidence).toBe(0.94);
  });
});

describe('two-column bank statement PDF (labels drawn before values)', () => {
  it('rows rebuilt by position: account number, IFSC (O -> 0) and holder all found', async () => {
    const r = (await readUploadedDocuments([doc(1, '/u/two-column.pdf', { type: 'BANK_PROOF' })], { ocr: fakeOcr(), blurThreshold: 30, readFile })).get(1)!;
    expect(r.payload).toEqual({ account_number: '50100234567891', ifsc: 'HDFC0001234', account_holder: 'RAVI KUMAR' });
  });
});

describe('scanned PDFs: pages rendered and OCR\'d', () => {
  const files: Record<string, Buffer> = {};
  const readScan = async (p: string) => files[p] ?? readFile(p);
  beforeAll(async () => {
    const png = FILES['/u/sharp.png']!;
    const meta = await sharp(png).metadata();
    const size = { width: meta.width!, height: meta.height! };
    const jpeg = await sharp(png).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
    const blurry = await sharp(png).flatten({ background: '#ffffff' }).blur(8).jpeg().toBuffer();
    files['/u/scan.pdf'] = scannedPdf(jpeg, size);
    files['/u/scan-header.pdf'] = scannedPdf(jpeg, size, { header: 'Name: SUNRISE TRADERS PVT LTD' });
    files['/u/scan-blurry.pdf'] = scannedPdf(blurry, size);
  });

  it('pdfPageImages renders the page as a PNG with the scan on it', async () => {
    const [page] = await pdfPageImages(files['/u/scan.pdf']!);
    const meta = await sharp(page!).metadata();
    expect(meta.format).toBe('png');
    expect(Math.max(meta.width!, meta.height!)).toBeGreaterThanOrEqual(2000);
    const { channels } = await sharp(page!).stats();
    expect(channels[0]!.min).toBeLessThan(100);
  });

  it('a scan without a text layer is OCR\'d: fields at the OCR confidence', async () => {
    const ocr = fakeOcr(PAN_SHARP_OCR_TEXT, 0.88);
    const r = (await readUploadedDocuments([doc(1, '/u/scan.pdf')], { ocr, blurThreshold: 30, readFile: readScan })).get(1)!;
    expect(r).toEqual({
      source: 'pdf',
      payload: { pan: 'AAFCS4321M', name: 'SUNRISE TRADERS PVT LTD' },
      confidence: 0.88,
      fieldConfidence: { pan: 0.88, name: 0.88 },
    });
    expect(ocr.calls).toBe(1);
  });

  it('a typed header plus a scan: text-layer fields win at PDF_TEXT_CONFIDENCE, OCR fills the rest', async () => {
    const ocr = fakeOcr('Permanent Account Number\nAAFCS4321M\nName\nSOMEONE ELSE\n', 0.8);
    const r = (await readUploadedDocuments([doc(1, '/u/scan-header.pdf')], { ocr, blurThreshold: 30, readFile: readScan })).get(1)!;
    expect(r.payload).toEqual({ name: 'SUNRISE TRADERS PVT LTD', pan: 'AAFCS4321M' });
    expect(r.confidence).toBe(PDF_TEXT_CONFIDENCE);
    expect(r.fieldConfidence).toEqual({ name: PDF_TEXT_CONFIDENCE, pan: 0.8 });
  });

  it('a blurry scan is a blurry document (reviewer), not sent to OCR', async () => {
    const ocr = fakeOcr();
    const r = (await readUploadedDocuments([doc(1, '/u/scan-blurry.pdf')], { ocr, blurThreshold: 30, readFile: readScan })).get(1)!;
    expect(r).toMatchObject({ source: 'pdf', payload: null, blurry: true });
    expect(r.blurScore).toBeLessThan(30);
    expect(ocr.calls).toBe(0);
  });

  it('a text-layer PDF with every field never renders or OCRs', async () => {
    const ocr = fakeOcr();
    await readUploadedDocuments([doc(1, '/u/gst.pdf', { type: 'GST_CERT' })], { ocr, blurThreshold: 30, readFile });
    expect(ocr.calls).toBe(0);
  });
});

describe('OCR passes', () => {
  it('stops at the first pass that finds every field', async () => {
    const ocr = scriptedOcr([PAN_SHARP_OCR_TEXT]);
    await readUploadedDocuments([doc(1, '/u/sharp.png')], { ocr, blurThreshold: 30, readFile });
    expect(ocr.modes).toEqual(['auto']);
  });

  it('keeps going until fields missing from one pass are found in another; the first value found wins', async () => {
    const ocr = scriptedOcr(['Permanent Account Number\nAAFCS4321M\n', 'nothing here', 'AAAAA9999A\nName\nSUNRISE TRADERS PVT LTD\n']);
    const r = (await readUploadedDocuments([doc(1, '/u/sharp.png')], { ocr, blurThreshold: 30, readFile })).get(1)!;
    expect(r.payload).toEqual({ pan: 'AAFCS4321M', name: 'SUNRISE TRADERS PVT LTD' });
    expect(ocr.modes).toEqual(['auto', 'auto', 'auto']);
  });

  it('tries every pass, ending with single-block segmentation, when a field is never found', async () => {
    const ocr = scriptedOcr(['AAFCS4321M']);
    const r = (await readUploadedDocuments([doc(1, '/u/sharp.png')], { ocr, blurThreshold: 30, readFile })).get(1)!;
    expect(r.payload).toEqual({ pan: 'AAFCS4321M' });
    expect(ocr.modes).toEqual(['auto', 'auto', 'auto', 'block']);
  });
});

describe('image formats', () => {
  it.each([
    ['webp', (s: Sharp) => s.webp()],
    ['tiff', (s: Sharp) => s.tiff()],
  ] as const)('a %s upload is decoded, blur-checked and OCR\'d like a PNG', async (ext, encode) => {
    const file = await encode(sharp(FILES['/u/sharp.png']!)).toBuffer();
    const ocr = fakeOcr();
    const r = (await readUploadedDocuments([doc(1, `/u/card.${ext}`)], { ocr, blurThreshold: 30, readFile: async () => file })).get(1)!;
    expect(r).toMatchObject({ source: 'ocr', blurry: false, payload: { pan: 'AAFCS4321M' } });
    expect(ocr.calls).toBe(1);
  });
});
