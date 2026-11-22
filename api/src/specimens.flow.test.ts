import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { decideAfterExtraction } from './extraction/decide.js';
import { extractFields, type ExtractionDocument } from './extraction/extract.js';
import { createTesseractOcr, type OcrEngine } from './extraction/ocr.js';
import { readUploadedDocuments } from './extraction/read.js';
import { SAMPLE_DIR } from './testing.js';

/*
 * The specimen documents (scripts/generate-specimens.mts) through the
 * existing pipeline, with real Tesseract: read, extract, decide. When a
 * specimen fails here, the specimen changes (font size, contrast,
 * watermark), never the pipeline.
 */

const SPECIMENS = join(SAMPLE_DIR, 'specimens');
const config = loadConfig({});
const cacheDir = resolve(fileURLToPath(new URL('../', import.meta.url)), config.ocrCacheDir);
const haveModel = existsSync(join(cacheDir, 'eng.traineddata')) || process.env.OCR_E2E === '1';

const FORM = {
  merchantName: 'Kaveri Looms Pvt Ltd',
  pan: 'AAKCK5678L',
  gst: '29AAKCK5678L1Z4',
  bankAccount: '30210987654321',
  ifsc: 'KKBK0008521',
};
const THRESHOLD = config.thresholds.confidence;

let ocr: OcrEngine;

/** Reads a full set of uploads and returns the extraction result and decision. */
async function run(files: { PAN_CARD: string; GST_CERT: string; BANK_PROOF: string }) {
  const docs = Object.entries(files).map(([type, name], i) => ({ id: i + 1, type, payload: null, path: join(SPECIMENS, name) }));
  const readings = await readUploadedDocuments(docs, { ocr, blurThreshold: config.thresholds.blur, readFile: async (p) => readFileSync(p) });
  const withReadings: ExtractionDocument[] = docs.map((d) => ({ ...d, reading: readings.get(d.id) }));
  const result = extractFields(FORM, withReadings, { nameThreshold: config.thresholds.nameMatch });
  return { readings, result, decision: decideAfterExtraction(result, { confidenceThreshold: THRESHOLD }) };
}

const TEXT_DOCS = { GST_CERT: 'gst-specimen.pdf', BANK_PROOF: 'bank-specimen.pdf' };

describe.runIf(haveModel)('specimen documents through the pipeline', () => {
  beforeAll(() => {
    ocr = createTesseractOcr({ cacheDir });
  });
  afterAll(async () => {
    await ocr?.terminate();
  });

  it.each(['pan-specimen.png', 'pan-specimen-tilted.jpg'])('%s: PAN and name read at or above the threshold; extraction passes', async (pan) => {
    const { readings, result, decision } = await run({ PAN_CARD: pan, ...TEXT_DOCS });
    expect(readings.get(1)!.payload).toEqual({ pan: FORM.pan, name: 'KAVERI LOOMS PVT LTD' });
    for (const f of result.fields) {
      expect(f.validationStatus, `${f.documentType}.${f.field}`).toBe('ok');
      expect(f.confidence, `${f.documentType}.${f.field}`).toBeGreaterThanOrEqual(THRESHOLD);
    }
    expect(decision).toMatchObject({ to: 'VERIFYING', reason: 'EXTRACTION_OK' });
  }, 120_000);

  it('pan-specimen-blurry.png: BLURRY_DOCUMENT', async () => {
    const { decision } = await run({ PAN_CARD: 'pan-specimen-blurry.png', ...TEXT_DOCS });
    expect(decision).toMatchObject({ to: 'IN_REVIEW', reason: 'BLURRY_DOCUMENT' });
    expect(decision.blurry.map((b) => b.documentType)).toEqual(['PAN_CARD']);
  }, 120_000);

  it('pan-specimen-name-mismatch.png: DOC_CONFLICT on the name', async () => {
    const { decision } = await run({ PAN_CARD: 'pan-specimen-name-mismatch.png', ...TEXT_DOCS });
    expect(decision).toMatchObject({ to: 'IN_REVIEW', reason: 'DOC_CONFLICT' });
    expect(decision.conflicts).toEqual([expect.objectContaining({ document: 'PAN_CARD', field: 'name', issue: 'name_mismatch' })]);
  }, 120_000);

  it('gst-specimen-scanned.pdf (no text layer): GSTIN and legal name found by OCR', async () => {
    const { readings, result } = await run({ PAN_CARD: 'pan-specimen.png', GST_CERT: 'gst-specimen-scanned.pdf', BANK_PROOF: 'bank-specimen.pdf' });
    const gst = readings.get(2)!;
    expect(gst.source).toBe('pdf');
    expect(gst.payload).toEqual({ gstin: FORM.gst, legal_name: FORM.merchantName });
    // Read from the rendered page, so per-field OCR confidences are present.
    expect(Object.keys(gst.fieldConfidence ?? {}).sort()).toEqual(['gstin', 'legal_name']);
    for (const f of result.fields.filter((x) => x.documentType === 'GST_CERT')) expect(f.validationStatus).toBe('ok');
  }, 120_000);

  it('the text-layer PDFs are read from the text, with the watermark ignored', async () => {
    const { readings } = await run({ PAN_CARD: 'pan-specimen.png', ...TEXT_DOCS });
    expect(readings.get(2)).toMatchObject({ payload: { gstin: FORM.gst, legal_name: FORM.merchantName } });
    expect(readings.get(3)).toMatchObject({ payload: { account_number: FORM.bankAccount, ifsc: FORM.ifsc, account_holder: FORM.merchantName } });
  }, 120_000);
});
