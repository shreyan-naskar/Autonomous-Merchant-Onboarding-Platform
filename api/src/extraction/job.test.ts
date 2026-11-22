import { describe, expect, it } from 'vitest';
import { describeDocument } from './job.js';

describe('describeDocument: one plain sentence for the review task', () => {
  it.each([
    [{ problem: 'wrong_document', looksLike: 'GST_CERT' }, 'PAN card: this looks like a GST certificate, not a PAN card.'],
    [{ problem: 'blank' }, 'PAN card: the upload is blank.'],
    [{ problem: 'password_protected' }, 'PAN card: the PDF is password-protected, so it could not be read.'],
    [{ problem: 'no_text' }, 'PAN card: no text found; the image does not look like a document.'],
    [{ problem: 'damaged' }, 'PAN card: the file is damaged or is not the kind of file its name says.'],
  ] as const)('%o', (p, sentence) => {
    expect(describeDocument({ documentType: 'PAN_CARD', documentId: 1, ...p })).toBe(sentence);
  });

  it('labels are lower-cased mid-sentence unless they start with an acronym', () => {
    expect(describeDocument({ documentType: 'GST_CERT', documentId: 2, problem: 'wrong_document', looksLike: 'BANK_PROOF' })).toBe(
      'GST certificate: this looks like a bank proof, not a GST certificate.',
    );
  });
});
