import type { OcrEngine } from './ocr.js';

/** Test fixtures for OCR and PDF reading (not imported by production code; also used by scripts/generate-sample-images.mts). */

/** Verbatim tesseract.js output for sample-data/pan-sharp.png. */
export const PAN_SHARP_OCR_TEXT =
  'INCOME TAX DEPARTMENT\nSAMPLE DOCUMENT - NOT VALID\n\nPermanent Account Number\nAAFCS4321M\n\nName\n\nSUNRISE TRADERS PVT LTD\nDate of Incorporation\n\n14/03/2019\n';

/** An OcrEngine that returns fixed text and counts calls. */
export function fakeOcr(text = PAN_SHARP_OCR_TEXT, confidence = 0.94): OcrEngine & { calls: number } {
  const engine = {
    calls: 0,
    async recognize() {
      engine.calls++;
      return { text, confidence };
    },
    async terminate() {},
  };
  return engine;
}

/** A one-page PDF with a Helvetica text layer, one line per entry. Hand-built: no PDF library needed. */
export function textPdf(lines: readonly string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = ['BT', '/F1 14 Tf', '18 TL', '72 770 Td', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export const SAMPLE_GST_CERT = [
  'Government of India - Form GST REG-06',
  'SAMPLE DOCUMENT - NOT VALID',
  'Registration Certificate',
  'Registration Number: 27AAFCS4321M1Z5',
  'Legal Name: Sunrise Traders Pvt Ltd',
  'Trade Name: Sunrise Traders',
  'Constitution of Business: Private Limited Company',
];

export const SAMPLE_BANK_PROOF = [
  'Sample Bank Ltd - Account Confirmation Letter',
  'SAMPLE DOCUMENT - NOT VALID',
  'Account Holder Name: Sunrise Traders Pvt Ltd',
  'Account Number: 6020 0987 6543 21',
  'IFSC: ICIC0004321',
  'Branch: Andheri East, Mumbai',
];
