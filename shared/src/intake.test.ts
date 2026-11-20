import { describe, expect, it } from 'vitest';
import {
  CreateApplicationJsonSchema,
  CreateApplicationMultipartFieldsSchema,
  GSTIN_RE,
  UpdateApplicationSchema,
} from './intake.js';

const valid = {
  merchant_name: 'Acme Traders',
  pan: 'abcde1234f',
  gst: '27ABCDE1234F1Z5',
  bank_account: '123456789012',
  ifsc: 'hdfc0001234',
  documents: [
    { type: 'PAN_CARD', payload: { pan: 'ABCDE1234F', name: 'Acme Traders' } },
    { type: 'BANK_PROOF', payload: { account_number: '123456789012', ifsc: 'HDFC0001234' } },
  ],
};

describe('CreateApplicationJsonSchema', () => {
  it('accepts a valid payload and normalises case', () => {
    const out = CreateApplicationJsonSchema.parse(valid);
    expect(out.pan).toBe('ABCDE1234F');
    expect(out.ifsc).toBe('HDFC0001234');
    expect(out.documents).toHaveLength(2);
  });

  it('defaults documents to [] and only requires merchant_name', () => {
    expect(CreateApplicationJsonSchema.parse({ merchant_name: 'Acme' }).documents).toEqual([]);
  });

  it('rejects unknown document types, unknown keys and duplicate types', () => {
    expect(CreateApplicationJsonSchema.safeParse({ ...valid, documents: [{ type: 'AADHAAR', payload: {} }] }).success).toBe(false);
    expect(CreateApplicationJsonSchema.safeParse({ ...valid, bankAccount: '1' }).success).toBe(false);
    expect(
      CreateApplicationJsonSchema.safeParse({ ...valid, documents: [valid.documents[0], valid.documents[0]] }).success,
    ).toBe(false);
  });

  it('issue messages never contain the submitted values', () => {
    const badPan = 'ABCDE1234FF';
    const badAcct = '12345678901234567890123';
    const r = CreateApplicationJsonSchema.safeParse({ ...valid, pan: badPan, bank_account: badAcct, gst: `X${badPan}` });
    expect(r.success).toBe(false);
    const text = JSON.stringify(r.error!.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })));
    expect(text).not.toContain(badPan);
    expect(text).not.toContain(badAcct);
    expect(r.error!.issues.map((i) => i.path.join('.')).sort()).toEqual(['bank_account', 'gst', 'pan']);
  });

  it('GSTIN format allows a magic GST ending in Z9', () => {
    expect(GSTIN_RE.test('29AACCM5678P1Z9')).toBe(true);
  });
});

describe('CreateApplicationMultipartFieldsSchema', () => {
  it('parses a JSON documents field', () => {
    const out = CreateApplicationMultipartFieldsSchema.parse({
      merchant_name: 'Acme',
      documents: JSON.stringify(valid.documents),
    });
    expect(out.documents).toHaveLength(2);
  });

  it('rejects malformed JSON without quoting it', () => {
    const r = CreateApplicationMultipartFieldsSchema.safeParse({ merchant_name: 'Acme', documents: '{ABCDE1234F' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).not.toContain('ABCDE1234F');
  });
});

describe('UpdateApplicationSchema', () => {
  it('requires at least one field', () => {
    expect(UpdateApplicationSchema.safeParse({}).success).toBe(false);
    expect(UpdateApplicationSchema.parse({ bank_account: '987654321' })).toEqual({ bank_account: '987654321' });
  });

  it('accepts structured documents alone, but not an empty list alone', () => {
    const doc = { type: 'GST_CERT', payload: { gstin: '27AABCL1234K1Z5', legal_name: 'Acme' } };
    expect(UpdateApplicationSchema.parse({ documents: [doc] })).toEqual({ documents: [doc] });
    expect(UpdateApplicationSchema.safeParse({ documents: [] }).success).toBe(false);
    expect(UpdateApplicationSchema.safeParse({ documents: [doc, doc] }).success).toBe(false);
    expect(UpdateApplicationSchema.safeParse({ documents: [{ type: 'PASSPORT', payload: {} }] }).success).toBe(false);
  });
});
