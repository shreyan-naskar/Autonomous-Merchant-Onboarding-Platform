import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OcrEngine } from './ocr.js';
import { pdfPageImages } from './pdf.js';
import { AMBIGUOUS_CONFIDENCE, GUESS_CONFIDENCE, PDF_TEXT_CONFIDENCE, readUploadedDocuments, valueConfidence, type ReadableDocument } from './read.js';
import { fakeOcr, PAN_SHARP_OCR_TEXT, passwordPdf, positionedPdf, SAMPLE_GST_CERT, scannedPdf, scriptedOcr, textPdf, TWO_COLUMN_BANK_PDF_ITEMS } from './testkit.js';
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

  it('a blank PDF (no text layer, nothing on the page) is reported as blank, without OCR', async () => {
    const deps = opts();
    const r = (await readUploadedDocuments([doc(1, '/u/scanned.pdf')], deps)).get(1)!;
    expect(r).toEqual({ source: 'pdf', payload: null, confidence: 0, error: 'blank' });
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

  it('a typed header plus a scan: OCR fills the rest; the exact text-layer value beats OCR noise', async () => {
    const ocr = fakeOcr('Name: SUNRLSE TRADERS PVT LTD\nPermanent Account Number\nAAFCS4321M\n', 0.8);
    const r = (await readUploadedDocuments([doc(1, '/u/scan-header.pdf')], { ocr, blurThreshold: 30, readFile: readScan })).get(1)!;
    expect(r.payload).toEqual({ pan: 'AAFCS4321M', name: 'SUNRISE TRADERS PVT LTD' });
    expect(r.confidence).toBe(PDF_TEXT_CONFIDENCE);
    expect(r.fieldConfidence).toEqual({ pan: 0.8, name: PDF_TEXT_CONFIDENCE });
  });

  it('a text-layer value the page does not show loses to what OCR reads', async () => {
    const ocr = fakeOcr('Name\nSOMEONE ELSE\nAAFCS4321M\n', 0.85);
    const r = (await readUploadedDocuments([doc(1, '/u/scan-header.pdf')], { ocr, blurThreshold: 30, readFile: readScan })).get(1)!;
    expect(r.payload).toEqual({ pan: 'AAFCS4321M', name: 'SOMEONE ELSE' });
    expect(r.fieldConfidence).toEqual({ pan: 0.85, name: 0.85 });
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

describe('edited PDFs: an old value hidden under a white box is still in the text layer', () => {
  const OLD = '19FOBPS6993J1ZY';
  const NEW = '19FJBPS6993J1ZY';
  // The editor draws the new value over the old one, at the same spot.
  const stacked = positionedPdf([
    { x: 40, y: 700, text: 'GSTIN' },
    { x: 140, y: 700, text: OLD },
    { x: 141, y: 700, text: NEW },
    { x: 40, y: 680, text: 'Legal Name' },
    { x: 140, y: 680, text: 'Shreyan Naskar' },
  ]);
  // Only the old value is left in the text layer; the new one is part of an image.
  const replaced = positionedPdf([
    { x: 40, y: 700, text: 'GSTIN' },
    { x: 140, y: 700, text: OLD },
    { x: 40, y: 680, text: 'Legal Name: Shreyan Naskar' },
    { x: 300, y: 680, text: 'CMLPN7378F' },
    { x: 301, y: 680, text: 'ABCDE1234F' },
  ]);
  const read = (pdf: Buffer, ocr: OcrEngine) =>
    readUploadedDocuments([doc(1, '/u/edited.pdf', { type: 'GST_CERT' })], { ocr, blurThreshold: 30, readFile: async () => pdf }).then((m) => m.get(1)!);

  it('two GSTINs stacked: the one the rendered page shows wins, at text-layer confidence', async () => {
    const ocr = fakeOcr(`GSTIN ${NEW}\nLegal Name Shreyan Naskar\n`, 0.8);
    const r = await read(stacked, ocr);
    expect(r.payload).toEqual({ gstin: NEW, legal_name: 'Shreyan Naskar' });
    expect(r.fieldConfidence).toEqual({ gstin: PDF_TEXT_CONFIDENCE, legal_name: PDF_TEXT_CONFIDENCE });
    expect(ocr.calls).toBeGreaterThan(0);
  });

  it('an overlapping (edited) layer: a near miss is not OCR noise, the page wins', async () => {
    const r = await read(replaced, fakeOcr(`GSTIN ${NEW}\nLegal Name: Shreyan Naskar\n`, 0.83));
    expect(r.payload!.gstin).toBe(NEW);
    expect(r.fieldConfidence!.gstin).toBe(0.83);
  });

  it('two GSTINs and the page settles nothing: the field is kept below the review threshold', async () => {
    const r = await read(stacked, fakeOcr('', 0.2));
    expect(r.fieldConfidence!.gstin).toBe(AMBIGUOUS_CONFIDENCE);
  });

  it('a clean, complete text layer is never rendered or OCR\'d', async () => {
    const ocr = fakeOcr();
    const r = await read(textPdf(['GSTIN: 27AAFCS4321M1Z5', 'Legal Name: Sunrise Traders Pvt Ltd']), ocr);
    expect(r).toEqual({ source: 'pdf', payload: { gstin: '27AAFCS4321M1Z5', legal_name: 'Sunrise Traders Pvt Ltd' }, confidence: PDF_TEXT_CONFIDENCE });
    expect(ocr.calls).toBe(0);
  });
});

/** Deterministic noise: an image with edges everywhere and no rows of text. */
async function noiseImage(width: number, height: number): Promise<Buffer> {
  const px = Buffer.alloc(width * height * 3);
  let seed = 42;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = seed & 0xff;
  }
  return sharp(px, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** Answers every call with the same text and per-word confidences, counting calls and keeping each image. */
function wordOcr(text: string, wordConfidence: Record<string, number>) {
  const images: Buffer[] = [];
  const engine: OcrEngine & { images: Buffer[] } = {
    images,
    async recognize(image) {
      images.push(image);
      const words = text.split(/\s+/).filter(Boolean).map((w) => ({ text: w, confidence: wordConfidence[w] ?? 0.95 }));
      return { text, confidence: 0.9, words };
    },
    async terminate() {},
  };
  return engine;
}

describe('readUploadedDocuments: uploads that are not what they should be', () => {
  beforeAll(async () => {
    const card = FILES['/u/sharp.png']!;
    FILES['/u/noise.png'] = await noiseImage(800, 600);
    FILES['/u/white.png'] = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#ffffff' } }).png().toBuffer();
    FILES['/u/upside-down.png'] = await sharp(card).rotate(180).png().toBuffer();
    FILES['/u/locked.pdf'] = passwordPdf();
    FILES['/u/gst-as-pan.pdf'] = textPdf(SAMPLE_GST_CERT);
  });
  const read = async (path: string, ocr: OcrEngine, type = 'PAN_CARD') =>
    (await readUploadedDocuments([doc(1, path, { type })], { ocr, blurThreshold: 30, readFile })).get(1)!;

  it('an image with no rows of text (noise, a photo) is "no_text", without running OCR', async () => {
    const ocr = fakeOcr();
    expect(await read('/u/noise.png', ocr)).toMatchObject({ payload: null, error: 'no_text' });
    expect(ocr.calls).toBe(0);
  });

  it('a blank image is "blank", not blurry', async () => {
    const ocr = fakeOcr();
    expect(await read('/u/white.png', ocr)).toEqual({ source: 'ocr', payload: null, confidence: 0, error: 'blank' });
    expect(ocr.calls).toBe(0);
  });

  it('a password-protected PDF is "password_protected", not "not_a_pdf"', async () => {
    expect(await read('/u/locked.pdf', fakeOcr(), 'GST_CERT')).toEqual({ source: 'pdf', payload: null, confidence: 0, error: 'password_protected' });
  });

  it('when the upright image yields no field, the other orientations are tried and a reading one is kept', async () => {
    const ocr = scriptedOcr(['garbled', PAN_SHARP_OCR_TEXT]);
    const r = await read('/u/upside-down.png', ocr);
    expect(r.payload).toEqual({ pan: 'AAFCS4321M', name: 'SUNRISE TRADERS PVT LTD' });
    // First pass upright, then the 180 degree turn, which found everything.
    expect(ocr.modes).toEqual(['auto', 'auto']);
  });

  it('a GST certificate in the PAN card slot: no PAN, and it says what the file looks like', async () => {
    const r = await read('/u/gst-as-pan.pdf', fakeOcr(SAMPLE_GST_CERT.join('\n')));
    expect(r.payload).not.toHaveProperty('pan');
    expect(r.looksLike).toBe('GST_CERT');
  });

  it('a PAN card whose PAN is found is never called another document', async () => {
    expect((await read('/u/sharp.png', fakeOcr())).looksLike).toBeUndefined();
  });

  it('three passes reading the same ID count as confident, even when Tesseract scores the code low', async () => {
    const ocr = wordOcr(PAN_SHARP_OCR_TEXT, { AAFCS4321M: 0.5 });
    const r = await read('/u/sharp.png', ocr);
    expect(r.fieldConfidence!.pan).toBe(0.9);
    // Stops once the ID is settled: the fourth pass is not needed.
    expect(ocr.images).toHaveLength(3);
  });

  it('an ID only found by correcting a look-alike character ("AAFC54321M") is kept below the review threshold', async () => {
    const text = PAN_SHARP_OCR_TEXT.replace('AAFCS4321M', 'AAFC54321M');
    const r = await read('/u/sharp.png', wordOcr(text, {}));
    expect(r.payload!.pan).toBe('AAFCS4321M');
    expect(r.fieldConfidence!.pan).toBe(GUESS_CONFIDENCE);
  });

  it('an ID split across words by OCR takes the confidence of its parts', () => {
    const words = [
      { text: '27AAFCS4321', confidence: 0.9 },
      { text: 'M1', confidence: 0.7 },
      { text: 'Z5', confidence: 0.95 },
    ];
    expect(valueConfidence('27AAFCS4321M1Z5', words, 0.1)).toBe(0.7);
    expect(valueConfidence('AAFCS4321M', [{ text: 'AAFCS4321Mm', confidence: 0.8 }], 0.1)).toBe(0.8);
  });
});

