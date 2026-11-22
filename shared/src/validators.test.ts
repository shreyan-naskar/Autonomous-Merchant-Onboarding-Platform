import { describe, expect, it } from 'vitest';
import {
  gstinMatchesPan,
  isValidBankAccount,
  isValidGstin,
  isValidIfsc,
  isValidPan,
  levenshtein,
  nameSimilarity,
  namesMatch,
  normalizeName,
} from './validators.js';

describe('isValidPan', () => {
  it.each(['ABCDE1234F', 'AABCL1234K', 'ZZZZZ9999Z'])('accepts %s', (v) => expect(isValidPan(v)).toBe(true));
  it.each([
    ['lowercase', 'abcde1234f'],
    ['too short', 'ABCDE1234'],
    ['too long', 'ABCDE1234FG'],
    ['digit where letter expected', 'ABCD11234F'],
    ['letter where digit expected', 'ABCDE12X4F'],
    ['last char digit', 'ABCDE12345'],
    ['inner whitespace', 'ABCDE 1234F'],
    ['empty', ''],
  ])('rejects %s', (_label, v) => expect(isValidPan(v)).toBe(false));
  it('rejects null / undefined', () => {
    expect(isValidPan(null)).toBe(false);
    expect(isValidPan(undefined)).toBe(false);
  });
});

describe('isValidGstin', () => {
  it.each(['27AABCL1234K1Z5', '07AADCG9012Q1Z3', '29AACCM5678P1Z9', '27AABCL1234KAZB'])('accepts %s', (v) =>
    expect(isValidGstin(v)).toBe(true),
  );
  it.each([
    ['14 chars', '27AABCL1234K1Z'],
    ['16 chars', '27AABCL1234K1Z55'],
    ['state code not digits', 'X7AABCL1234K1Z5'],
    ['14th char not Z', '27AABCL1234K1Y5'],
    ['entity number 0', '27AABCL1234K0Z5'],
    ['embedded PAN malformed', '27AAB1L1234K1Z5'],
    ['lowercase', '27aabcl1234k1z5'],
  ])('rejects %s', (_label, v) => expect(isValidGstin(v)).toBe(false));
});

describe('gstinMatchesPan', () => {
  it('true when characters 3-12 equal the PAN', () => {
    expect(gstinMatchesPan('27AABCL1234K1Z5', 'AABCL1234K')).toBe(true);
  });
  it('false when the embedded PAN differs', () => {
    expect(gstinMatchesPan('27AABCL1234K1Z5', 'AABCL1234L')).toBe(false);
    expect(gstinMatchesPan('27AADCG9012Q1Z3', 'AABCL1234K')).toBe(false);
  });
  it('false when either side is malformed or absent (never a vacuous match)', () => {
    expect(gstinMatchesPan('27AABCL1234K1Z', 'AABCL1234K')).toBe(false);
    expect(gstinMatchesPan('27AABCL1234K1Z5', 'AABCL1234')).toBe(false);
    expect(gstinMatchesPan(null, 'AABCL1234K')).toBe(false);
    expect(gstinMatchesPan('27AABCL1234K1Z5', undefined)).toBe(false);
  });
});

describe('isValidIfsc', () => {
  it.each(['HDFC0001234', 'SBIN0003456', 'ICIC0ABC123'])('accepts %s', (v) => expect(isValidIfsc(v)).toBe(true));
  it.each([
    ['5th char not 0', 'HDFC1001234'],
    ['too short', 'HDFC000123'],
    ['too long', 'HDFC00012345'],
    ['digits in bank code', 'HD1C0001234'],
    ['lowercase', 'hdfc0001234'],
  ])('rejects %s', (_label, v) => expect(isValidIfsc(v)).toBe(false));
});

describe('isValidBankAccount', () => {
  it.each(['123456789', '50100234567891', '123456789012345678'])('accepts %s', (v) =>
    expect(isValidBankAccount(v)).toBe(true),
  );
  it.each(['12345678', '1234567890123456789', '5010023456789X', ''])('rejects %s', (v) =>
    expect(isValidBankAccount(v)).toBe(false),
  );
});

describe('normalizeName', () => {
  it.each([
    ['Lakshmi Textiles Pvt Ltd', 'lakshmi textiles'],
    ['LAKSHMI TEXTILES PVT. LTD.', 'lakshmi textiles'],
    ['Lakshmi Textiles Private Limited', 'lakshmi textiles'],
    ['  Lakshmi   Textiles,  Pvt.Ltd ', 'lakshmi textiles'],
    ['M/s. Lakshmi Textiles (P) Ltd', 'lakshmi textiles'],
    ['Ganesh Hardware Stores', 'ganesh hardware stores'],
    ['Acme LLP', 'acme'],
    ["O'Brien & Sons Co.", 'obrien sons'],
  ])('%s -> %s', (input, expected) => expect(normalizeName(input)).toBe(expected));

  it('keeps a suffix word that is the whole name', () => {
    // A name made only of suffix words must not normalize to empty.
    expect(normalizeName('Limited')).toBe('limited');
  });
});

describe('levenshtein', () => {
  it.each([
    ['', '', 0],
    ['abc', '', 3],
    ['kitten', 'sitting', 3],
    ['flaw', 'lawn', 2],
    ['same', 'same', 0],
  ] as const)('%s vs %s = %d', (a, b, d) => expect(levenshtein(a, b)).toBe(d));
});

describe('nameSimilarity / namesMatch', () => {
  it('is 1 for names equal after normalization', () => {
    expect(nameSimilarity('Lakshmi Textiles Pvt Ltd', 'LAKSHMI TEXTILES PRIVATE LIMITED')).toBe(1);
  });
  it('is symmetric', () => {
    const a = 'Lakshmi Textile';
    const b = 'Lakshmi Textiles Pvt Ltd';
    expect(nameSimilarity(a, b)).toBeCloseTo(nameSimilarity(b, a), 10);
  });
  it('tolerates a one-letter typo (Levenshtein ratio)', () => {
    expect(nameSimilarity('Lakshmi Textile', 'Lakshmi Textiles')).toBeGreaterThan(0.9);
    expect(namesMatch('Lakshmi Textile', 'Lakshmi Textiles', 0.85)).toBe(true);
  });
  it('tolerates reordered words (token overlap)', () => {
    expect(nameSimilarity('Textiles Lakshmi', 'Lakshmi Textiles')).toBe(1);
  });
  it('rejects a different business (conflict.json)', () => {
    const s = nameSimilarity('Ramesh Electricals Pvt Ltd', 'Ganesh Hardware Stores');
    expect(s).toBeLessThan(0.5);
    expect(namesMatch('Ramesh Electricals Pvt Ltd', 'Ganesh Hardware Stores', 0.85)).toBe(false);
  });
  it('rejects a partial name below threshold', () => {
    expect(namesMatch('Lakshmi', 'Lakshmi Textiles', 0.85)).toBe(false);
  });
  it('is 0 when either name is empty or absent', () => {
    expect(nameSimilarity('', 'Lakshmi')).toBe(0);
    expect(nameSimilarity(null, 'Lakshmi')).toBe(0);
    expect(namesMatch(undefined, 'Lakshmi', 0.5)).toBe(false);
  });
  it('stays within [0, 1]', () => {
    for (const [a, b] of [
      ['a', 'b'],
      ['abc def', 'abc'],
      ['x y z', 'z y x w'],
    ]) {
      const s = nameSimilarity(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
