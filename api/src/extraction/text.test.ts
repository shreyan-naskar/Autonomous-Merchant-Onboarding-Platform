import { describe, expect, it } from 'vitest';
import { PAN_SHARP_OCR_TEXT } from './testkit.js';
import { parseDocumentText } from './text.js';

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
