import { describe, expect, it } from 'vitest';
import { mask, redactText } from './mask.js';

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
