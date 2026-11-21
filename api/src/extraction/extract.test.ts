import { describe, expect, it } from 'vitest';
import { decideAfterExtraction } from './decide.js';
import {
  extractFields,
  FORMAT_FAIL_CONFIDENCE,
  type ExtractionDocument,
  type ExtractionForm,
  type ExtractionResult,
} from './extract.js';
import { sample } from '../testing.js';

interface Sample {
  merchant_name: string;
  pan?: string;
  gst?: string;
  bank_account?: string;
  ifsc?: string;
  documents: { type: string; payload: Record<string, string> }[];
}
const loadSample = (name: string): Sample => sample(name);

const OPTS = { nameThreshold: 0.85 };
const THRESHOLD = { confidenceThreshold: 0.8 };

function formOf(s: Sample): ExtractionForm {
  return {
    merchantName: s.merchant_name,
    pan: s.pan ?? null,
    gst: s.gst ?? null,
    bankAccount: s.bank_account ?? null,
    ifsc: s.ifsc ?? null,
  };
}
const docsOf = (s: Sample): ExtractionDocument[] =>
  s.documents.map((d, i) => ({ id: i + 1, type: d.type, payload: d.payload, path: null }));

function run(s: Sample) {
  const result = extractFields(formOf(s), docsOf(s), OPTS);
  return { result, decision: decideAfterExtraction(result, THRESHOLD) };
}

/** happy.json with one document payload edited. */
function happyWith(type: string, patch: Record<string, string | undefined>): Sample {
  const s = loadSample('happy.json');
  s.documents = s.documents.map((d) => (d.type === type ? { ...d, payload: { ...d.payload, ...patch } as Record<string, string> } : d));
  return s;
}
const field = (r: ExtractionResult, name: string) => r.fields.find((f) => f.field === name)!;

describe('extractFields', () => {
  it('happy.json: seven fields, all ok at confidence 1.0, nothing missing', () => {
    const { result } = run(loadSample('happy.json'));
    expect(result.fields.map((f) => `${f.documentType}.${f.field}`)).toEqual([
      'PAN_CARD.pan',
      'PAN_CARD.name',
      'GST_CERT.gst',
      'GST_CERT.legal_name',
      'BANK_PROOF.bank_account',
      'BANK_PROOF.ifsc',
      'BANK_PROOF.account_holder',
    ]);
    expect(result.fields.every((f) => f.validationStatus === 'ok' && f.confidence === 1)).toBe(true);
    expect(result.missingDocuments).toEqual([]);
    expect(result.missingFormFields).toEqual([]);
    expect(field(result, 'pan')).toMatchObject({ documentId: 1, value: 'AABCL1234K' });
  });

  it('normalizes case and whitespace of document codes', () => {
    const { result } = run(happyWith('PAN_CARD', { pan: '  aabcl1234k ' }));
    expect(field(result, 'pan')).toMatchObject({ value: 'AABCL1234K', validationStatus: 'ok' });
  });

  it('a document value failing its format gets reduced confidence and low_confidence', () => {
    const { result } = run(happyWith('BANK_PROOF', { ifsc: 'HDFC1001234' }));
    expect(field(result, 'ifsc')).toMatchObject({
      confidence: FORMAT_FAIL_CONFIDENCE,
      validationStatus: 'low_confidence',
      issue: 'invalid_format',
    });
  });

  it('a value differing from the form is a mismatch', () => {
    const { result } = run(happyWith('BANK_PROOF', { account_number: '50100234567892' }));
    expect(field(result, 'bank_account')).toMatchObject({ validationStatus: 'mismatch', issue: 'differs_from_form', confidence: 1 });
  });

  it('a GSTIN that does not embed the PAN is a mismatch even if it equals the form GSTIN', () => {
    const s = happyWith('GST_CERT', { gstin: '27AADCG9012Q1Z3' });
    s.gst = '27AADCG9012Q1Z3';
    const { result } = run(s);
    expect(field(result, 'gst')).toMatchObject({ validationStatus: 'mismatch', issue: 'gstin_pan_mismatch' });
  });

  it('name fields tolerate legal-suffix differences but flag a different business', () => {
    const ok = run(happyWith('BANK_PROOF', { account_holder: 'LAKSHMI TEXTILES PRIVATE LIMITED' })).result;
    expect(field(ok, 'account_holder')).toMatchObject({ validationStatus: 'ok', similarity: 1 });

    const { result } = run(loadSample('conflict.json'));
    const name = field(result, 'name');
    expect(name).toMatchObject({ documentType: 'PAN_CARD', validationStatus: 'mismatch', issue: 'name_mismatch' });
    expect(name.similarity).toBeLessThan(0.5);
  });

  it('an absent payload value is missing with confidence 0', () => {
    const { result } = run(happyWith('PAN_CARD', { name: undefined }));
    expect(field(result, 'name')).toMatchObject({ value: null, confidence: 0, validationStatus: 'missing' });
  });

  it('reports missing documents and missing form fields', () => {
    const s = loadSample('missing.json');
    delete s.ifsc;
    const { result } = run(s);
    expect(result.missingDocuments).toEqual(['GST_CERT']);
    expect(result.missingFormFields).toEqual(['ifsc']);
    expect(result.fields.some((f) => f.documentType === 'GST_CERT')).toBe(false);
  });

  it('an uploaded file without a structured payload is unreadable (low confidence), not missing', () => {
    const s = loadSample('happy.json');
    const docs = docsOf(s).map((d) => (d.type === 'PAN_CARD' ? { ...d, payload: null, path: '/uploads/x.pdf' } : d));
    const result = extractFields(formOf(s), docs, OPTS);
    expect(result.fields.filter((f) => f.documentType === 'PAN_CARD').map((f) => [f.validationStatus, f.issue, f.confidence])).toEqual([
      ['low_confidence', 'unreadable', 0],
      ['low_confidence', 'unreadable', 0],
    ]);
  });

  it('skips form comparison when the form value is absent (that is reported as missing instead)', () => {
    const s = loadSample('happy.json');
    delete s.pan;
    const { result } = run(s);
    expect(field(result, 'pan').validationStatus).toBe('ok');
    // GSTIN is checked against the PAN card's PAN instead.
    expect(field(result, 'gst').validationStatus).toBe('ok');
    expect(result.missingFormFields).toEqual(['pan']);
  });
});

describe('decideAfterExtraction', () => {
  it('happy.json -> VERIFYING', () => {
    expect(run(loadSample('happy.json')).decision).toEqual({
      to: 'VERIFYING',
      reason: 'EXTRACTION_OK',
      event: 'VERIFICATION_STARTED',
      missing: [],
      blurry: [],
      conflicts: [],
      lowConfidence: [],
    });
  });

  it('gst-fail.json is clean at extraction (GST fails later at the provider) -> VERIFYING', () => {
    expect(run(loadSample('gst-fail.json')).decision.to).toBe('VERIFYING');
  });

  it('missing.json -> NEEDS_INFO listing the missing document', () => {
    expect(run(loadSample('missing.json')).decision).toMatchObject({
      to: 'NEEDS_INFO',
      reason: 'MISSING_INFO',
      event: 'INFO_REQUIRED',
      missing: ['document.GST_CERT'],
    });
  });

  it('lists form fields, documents and document values in the missing list', () => {
    const s = happyWith('PAN_CARD', { name: undefined });
    delete s.bank_account;
    s.documents = s.documents.filter((d) => d.type !== 'BANK_PROOF');
    expect(run(s).decision.missing).toEqual(['form.bank_account', 'document.BANK_PROOF', 'PAN_CARD.name']);
  });

  it('conflict.json -> IN_REVIEW DOC_CONFLICT naming the field', () => {
    const d = run(loadSample('conflict.json')).decision;
    expect(d).toMatchObject({ to: 'IN_REVIEW', reason: 'DOC_CONFLICT', event: 'DOC_CONFLICT', missing: [] });
    expect(d.conflicts).toEqual([{ document: 'PAN_CARD', field: 'name', issue: 'name_mismatch', similarity: expect.any(Number) }]);
  });

  it('format failure -> IN_REVIEW LOW_CONFIDENCE', () => {
    const d = run(happyWith('PAN_CARD', { pan: 'AABCL12345' })).decision;
    expect(d).toMatchObject({ to: 'IN_REVIEW', reason: 'LOW_CONFIDENCE' });
    expect(d.lowConfidence).toEqual([{ document: 'PAN_CARD', field: 'pan', issue: 'invalid_format', confidence: FORMAT_FAIL_CONFIDENCE }]);
  });

  it('uses the configured confidence threshold', () => {
    const { result } = run(happyWith('PAN_CARD', { pan: 'AABCL12345' }));
    expect(decideAfterExtraction(result, { confidenceThreshold: 0.4 }).to).toBe('VERIFYING');
  });

  it('priority: missing beats conflict beats low confidence', () => {
    const all = happyWith('PAN_CARD', { name: 'Someone Else Entirely' });
    all.documents = all.documents.map((d) => (d.type === 'BANK_PROOF' ? { ...d, payload: { ...d.payload, ifsc: 'BAD' } } : d));
    expect(run(all).decision).toMatchObject({ to: 'IN_REVIEW', reason: 'DOC_CONFLICT' });
    expect(run(all).decision.lowConfidence).toHaveLength(1);

    all.documents = all.documents.filter((d) => d.type !== 'GST_CERT');
    expect(run(all).decision).toMatchObject({ to: 'NEEDS_INFO', missing: ['document.GST_CERT'] });
    expect(run(all).decision.conflicts).toHaveLength(1);
  });
});

describe('documents read from an uploaded image (OCR)', () => {
  /** happy.json with the PAN card as an upload read by OCR. */
  function withPanReading(reading: ExtractionDocument['reading']) {
    const s = loadSample('happy.json');
    const docs = docsOf(s).map((d) => (d.type === 'PAN_CARD' ? { ...d, payload: null, path: '/u/pan.png', reading } : d));
    const result = extractFields(formOf(s), docs, OPTS);
    return { result, decision: decideAfterExtraction(result, THRESHOLD) };
  }
  const read = (payload: Record<string, string>, confidence = 0.94) => ({
    source: 'ocr' as const,
    payload,
    confidence,
    blurScore: 900,
    blurry: false,
  });
  const GOOD = { pan: 'AABCL1234K', name: 'LAKSHMI TEXTILES PVT LTD' };

  it('a clean read: fields ok, carrying the OCR confidence -> VERIFYING', () => {
    const { result, decision } = withPanReading(read(GOOD));
    expect(field(result, 'pan')).toMatchObject({ validationStatus: 'ok', confidence: 0.94, value: 'AABCL1234K' });
    expect(field(result, 'name')).toMatchObject({ validationStatus: 'ok', confidence: 0.94 });
    expect(decision.reason).toBe('EXTRACTION_OK');
  });

  it('low OCR confidence -> IN_REVIEW LOW_CONFIDENCE', () => {
    const { decision } = withPanReading(read(GOOD, 0.6));
    expect(decision).toMatchObject({ to: 'IN_REVIEW', reason: 'LOW_CONFIDENCE' });
    expect(decision.lowConfidence.map((p) => p.field)).toEqual(['pan', 'name']);
  });

  it('OCR read a PAN that differs from the form -> DOC_CONFLICT', () => {
    const { decision } = withPanReading(read({ ...GOOD, pan: 'AABCL9999K' }));
    expect(decision).toMatchObject({ to: 'IN_REVIEW', reason: 'DOC_CONFLICT' });
    expect(decision.conflicts).toEqual([{ document: 'PAN_CARD', field: 'pan', issue: 'differs_from_form' }]);
  });

  it('a value OCR could not find is unreadable (review), not missing (NEEDS_INFO)', () => {
    const { result, decision } = withPanReading(read({ pan: 'AABCL1234K' }));
    expect(field(result, 'name')).toMatchObject({ validationStatus: 'low_confidence', issue: 'unreadable', confidence: 0 });
    expect(decision).toMatchObject({ to: 'IN_REVIEW', reason: 'LOW_CONFIDENCE' });
  });

  it('a garbled PAN fails its format at no more than 0.5 (and no more than the OCR confidence)', () => {
    const { result } = withPanReading(read({ ...GOOD, pan: 'AABC11234K' }, 0.4));
    expect(field(result, 'pan')).toMatchObject({ validationStatus: 'low_confidence', issue: 'invalid_format', confidence: 0.4 });
  });

  it('a blurry image -> IN_REVIEW BLURRY_DOCUMENT, ahead of conflicts elsewhere', () => {
    const s = loadSample('happy.json');
    const docs = docsOf(s).map((d) =>
      d.type === 'PAN_CARD'
        ? { ...d, payload: null, path: '/u/pan.png', reading: { source: 'ocr' as const, payload: null, confidence: 0, blurScore: 1.7, blurry: true } }
        : d.type === 'GST_CERT'
          ? { ...d, payload: { gstin: s.gst!, legal_name: 'Someone Else Entirely' } }
          : d,
    );
    const result = extractFields(formOf(s), docs, OPTS);
    expect(result.blurryDocuments).toEqual([{ documentType: 'PAN_CARD', documentId: 1, blurScore: 1.7 }]);
    expect(field(result, 'pan')).toMatchObject({ validationStatus: 'low_confidence', issue: 'blurry', value: null });
    const decision = decideAfterExtraction(result, THRESHOLD);
    expect(decision).toMatchObject({ to: 'IN_REVIEW', reason: 'BLURRY_DOCUMENT', event: 'BLURRY_DOCUMENT' });
    expect(decision.conflicts).toHaveLength(1);
  });

  it('missing information still wins over a blurry image (NEEDS_INFO)', () => {
    const s = loadSample('happy.json');
    const docs = docsOf(s)
      .filter((d) => d.type !== 'GST_CERT')
      .map((d) =>
        d.type === 'PAN_CARD'
          ? { ...d, payload: null, path: '/u/pan.png', reading: { source: 'ocr' as const, payload: null, confidence: 0, blurScore: 1, blurry: true } }
          : d,
      );
    expect(decideAfterExtraction(extractFields(formOf(s), docs, OPTS), THRESHOLD).reason).toBe('MISSING_INFO');
  });

  it('a structured payload wins over a reading of the same document', () => {
    const s = loadSample('happy.json');
    const docs = docsOf(s).map((d) =>
      d.type === 'PAN_CARD' ? { ...d, reading: { source: 'ocr' as const, payload: null, confidence: 0, blurScore: 1, blurry: true } } : d,
    );
    expect(decideAfterExtraction(extractFields(formOf(s), docs, OPTS), THRESHOLD).reason).toBe('EXTRACTION_OK');
  });
});
