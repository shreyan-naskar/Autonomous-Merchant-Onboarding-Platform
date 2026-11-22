import { describe, expect, it } from 'vitest';
import { mask, maskDeep, redactText } from './mask.js';

describe('mask', () => {
  it('shows only the last 4 characters', () => {
    expect(mask('ABCDE1234F')).toBe('******234F');
    expect(mask('123456789012')).toBe('********9012');
  });

  it('fully masks values of 4 characters or fewer', () => {
    expect(mask('1234')).toBe('****');
    expect(mask('ab')).toBe('**');
  });

  it('passes through null/undefined/empty', () => {
    expect(mask(null)).toBeNull();
    expect(mask(undefined)).toBeNull();
    expect(mask('')).toBe('');
  });
});

describe('redactText', () => {
  it('masks PAN-shaped and account-number-shaped substrings in free text', () => {
    const out = redactText('PAN ABCDE1234F and account 123456789012 failed');
    expect(out).not.toContain('ABCDE1234F');
    expect(out).not.toContain('123456789012');
    expect(out).toContain('234F');
    expect(out).toContain('9012');
  });

  it('masks the PAN embedded inside a GSTIN', () => {
    const out = redactText('gst 27ABCDE1234F1Z5');
    expect(out).not.toContain('ABCDE1234F');
  });

  it('leaves ordinary text alone', () => {
    expect(redactText('application 42 moved to VERIFYING')).toBe(
      'application 42 moved to VERIFYING',
    );
  });
});

describe('maskDeep', () => {
  const PAN = 'ABCDE1234F';
  const GSTIN = '27ABCDE1234F1Z5';
  const ACCT = '123456789012';

  it('masks sensitive keys at any depth and scrubs PAN/account text elsewhere', () => {
    const out = maskDeep({
      pan: PAN,
      nested: { gstin: GSTIN, list: [{ account_number: ACCT }, { bankAccount: ACCT }] },
      note: `checked ${PAN} against ${ACCT}`,
      name: 'Acme Traders',
      count: 3,
      ok: true,
      none: null,
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain(PAN);
    expect(json).not.toContain(ACCT);
    expect(out).toMatchObject({
      pan: '******234F',
      nested: { gstin: '***********F1Z5' },
      name: 'Acme Traders',
      count: 3,
      ok: true,
      none: null,
    });
  });

  it('redacts non-string values under sensitive keys', () => {
    expect(maskDeep({ pan: { raw: PAN } })).toEqual({ pan: '[REDACTED]' });
    expect(maskDeep({ bank_account: 123456789012 })).toEqual({ bank_account: '********9012' });
  });

  it('leaves id-like keys untouched so all-digit UUID groups are not mangled', () => {
    const id = '0f8a2c1e-1111-4222-8333-123456789012';
    expect(maskDeep({ application_id: id, requestId: id })).toEqual({ application_id: id, requestId: id });
  });

  it('does not mutate its input', () => {
    const input = { pan: PAN };
    maskDeep(input);
    expect(input.pan).toBe(PAN);
  });
});
