import { describe, expect, it } from 'vitest';
import { PAN_SHARP_OCR_TEXT } from './testkit.js';
import { cleanName, parseDocumentText } from './text.js';

describe('parseDocumentText', () => {
  it('PAN card: PAN by pattern, name from the line after the "Name" label', () => {
    expect(parseDocumentText('PAN_CARD', PAN_SHARP_OCR_TEXT)).toEqual({ pan: 'AAFCS4321M', name: 'SUNRISE TRADERS PVT LTD' });
  });

  it('PAN card: "Name: value" on one line; "Father\'s Name" is not the name', () => {
    const text = "Father's Name\nRAMESH KUMAR\nName: Lakshmi Textiles Pvt Ltd\npan aabcl1234k";
    expect(parseDocumentText('PAN_CARD', text)).toEqual({ pan: 'AABCL1234K', name: 'Lakshmi Textiles Pvt Ltd' });
  });

  it('PAN card: does not take the PAN embedded in a GSTIN, and leaves out what it cannot find', () => {
    expect(parseDocumentText('PAN_CARD', 'GSTIN 27AABCL1234K1Z5\nNamesake Corp')).toEqual({});
  });

  it('GST certificate: GSTIN and legal name', () => {
    const text = 'Form GST REG-06\nRegistration Number: 27AABCL1234K1Z5\nLegal Name of Business: Lakshmi Textiles Pvt Ltd\nTrade Name: Lakshmi';
    expect(parseDocumentText('GST_CERT', text)).toEqual({ gstin: '27AABCL1234K1Z5', legal_name: 'Lakshmi Textiles Pvt Ltd' });
  });

  it('bank proof: grouped account number, IFSC, holder', () => {
    const text = 'HDFC Bank\nAccount Holder Name: Lakshmi Textiles Pvt Ltd\nAccount No.: 5010 0234 5678 91\nIFSC: HDFC0001234\nBranch: Mumbai';
    expect(parseDocumentText('BANK_PROOF', text)).toEqual({
      account_number: '50100234567891',
      ifsc: 'HDFC0001234',
      account_holder: 'Lakshmi Textiles Pvt Ltd',
    });
  });

  it('bank proof: an account number outside 9-18 digits is not taken', () => {
    expect(parseDocumentText('BANK_PROOF', 'Account Number: 1234 5678').account_number).toBeUndefined();
  });
});

/*
 * Layouts seen on a real PAN card (OCR) and a real bank statement PDF, with
 * fictitious values. Each case failed before these fixes.
 */
describe('parseDocumentText on real-world layouts', () => {
  // Bilingual PAN card: "नाम / Name" OCRs as junk before "Name"; OCR noise after the name.
  const REAL_PAN_OCR = [
    'Ae Re ae (aa 3)',
    'INCOME TAX DEPARTMENT ~~ & GOVT. OF INDIA',
    'Permanent Account Number Card Bxdz',
    'ABCDE1234F ee',
    'H/ Name a Rs',
    'RAVI KUMAR Wid aA',
    'faa 4 ATA/ Father\'s Name ama a SURESH ak',
    'Date of Birth ~~ = /a',
    '01/01/1990 ~~ ABC Signature',
  ].join('\n');

  it('PAN card: "Name" after bilingual junk; only the capitalized name words are kept', () => {
    expect(parseDocumentText('PAN_CARD', REAL_PAN_OCR)).toEqual({ pan: 'ABCDE1234F', name: 'RAVI KUMAR' });
  });

  it('PAN card: a Father\'s Name that comes first is skipped', () => {
    const text = "Father's Name\nSURESH KUMAR\nनाम / Name\nRAVI KUMAR\nABCDE1234F";
    expect(parseDocumentText('PAN_CARD', text).name).toBe('RAVI KUMAR');
  });

  it('bank: two-column rows (tab = column break), title dropped, Branch Name skipped, IFSC O -> 0', () => {
    const text = [
      'Branch Name: ANDHERI EAST',
      'Name: Mr. RAVI KUMAR\tCIF Number : 81234567890',
      'Account No. : 50100234567891\tMICR: 400240002',
      'A/c Type : SAVINGS',
      'IFSC: HDFCO001234',
    ].join('\n');
    expect(parseDocumentText('BANK_PROOF', text)).toEqual({
      account_number: '50100234567891',
      ifsc: 'HDFC0001234',
      account_holder: 'RAVI KUMAR',
    });
  });

  it('bank: a label whose value is on the next line still works', () => {
    expect(parseDocumentText('BANK_PROOF', 'Account Number\n5010 0234 5678 91').account_number).toBe('50100234567891');
  });

  it('GST: a redacted or unreadable legal name does not take the next row\'s label as the name', () => {
    const text = 'GSTIN\t33\nLegal Name\t~~ ~~~\nRegistration Details under Existing Law\n';
    expect(parseDocumentText('GST_CERT', text).legal_name).toBeUndefined();
    expect(parseDocumentText('GST_CERT', 'Legal Name\nSunrise Traders Pvt Ltd').legal_name).toBe('Sunrise Traders Pvt Ltd');
  });
});

describe('cleanName', () => {
  it.each([
    ['RAVI KUMAR Wid aA', 'RAVI KUMAR'],
    ['Mr. RAVI KUMAR', 'RAVI KUMAR'],
    ['M/s Lakshmi Textiles Pvt Ltd', 'Lakshmi Textiles Pvt Ltd'],
    ['Lakshmi & Sons', 'Lakshmi & Sons'],
    ['R. K. SHARMA 12/03', 'R. K. SHARMA'],
  ])('%s -> %s', (raw, name) => {
    expect(cleanName(raw)).toBe(name);
  });

  it.each(['a Rs', '81234567890', ': ~~', 'Mr.', 'Ab'])('rejects %s', (raw) => {
    expect(cleanName(raw)).toBeNull();
  });
});
