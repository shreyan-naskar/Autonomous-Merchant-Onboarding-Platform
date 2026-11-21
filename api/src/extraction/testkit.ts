import type { OcrEngine, OcrMode } from './ocr.js';

/** Test fixtures for OCR and PDF reading (not imported by production code; also used by scripts/generate-sample-images.mts). */

/** Verbatim tesseract.js output for sample-data/pan-sharp.png. */
export const PAN_SHARP_OCR_TEXT =
  'INCOME TAX DEPARTMENT\nSAMPLE DOCUMENT - NOT VALID\n\nPermanent Account Number\nAAFCS4321M\n\nName\n\nSUNRISE TRADERS PVT LTD\nDate of Incorporation\n\n14/03/2019\n';

/** An OcrEngine that returns fixed text (and optional per-word confidences) and counts calls. */
export function fakeOcr(
  text = PAN_SHARP_OCR_TEXT,
  confidence = 0.94,
  words?: { text: string; confidence: number }[],
): OcrEngine & { calls: number } {
  const engine = {
    calls: 0,
    async recognize() {
      engine.calls++;
      return { text, confidence, ...(words ? { words } : {}) };
    },
    async terminate() {},
  };
  return engine;
}

/** Objects 1..n of a PDF, in order (object 1 is the catalog). Binary stream data is kept as bytes. */
function buildPdf(objects: readonly (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  const push = (b: Buffer) => {
    parts.push(b);
    length += b.length;
  };
  objects.forEach((body, i) => {
    offsets.push(length);
    push(Buffer.from(`${i + 1} 0 obj\n`, 'latin1'));
    push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
    push(Buffer.from('\nendobj\n', 'latin1'));
  });
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  tail += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

/** Wrap a content stream in a minimal one-page PDF (Helvetica as /F1). */
function pdfWithContent(content: string): Buffer {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ]);
}

/**
 * A scanned document: an A4 page whose only content is a JPEG, drawn
 * `widthPt` points wide near the top, with no text layer (optionally a typed
 * header line above it, as some scanners add).
 */
export function scannedPdf(jpeg: Buffer, size: { width: number; height: number }, opts: { widthPt?: number; header?: string } = {}): Buffer {
  const w = opts.widthPt ?? 500;
  const h = Math.round((w * size.height) / size.width);
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const header = opts.header ? `BT /F1 10 Tf 50 810 Td (${esc(opts.header)}) Tj ET\n` : '';
  const content = `${header}q ${w} 0 0 ${h} 50 ${790 - h} cm /Im1 Do Q`;
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        'latin1',
      ),
      jpeg,
      Buffer.from('\nendstream', 'latin1'),
    ]),
  ]);
}

/** An OcrEngine that answers each call with the next scripted text and records the segmentation mode it was asked for. */
export function scriptedOcr(texts: readonly string[], confidence = 0.9): OcrEngine & { modes: string[] } {
  const engine = {
    modes: [] as string[],
    async recognize(_image: Buffer, mode: OcrMode = 'auto') {
      const text = texts[Math.min(engine.modes.length, texts.length - 1)] ?? '';
      engine.modes.push(mode);
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
  return pdfWithContent(content);
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

/**
 * A one-page PDF with text drawn at absolute positions, in the order given
 * (so a test can draw a two-column layout column by column, as real bank
 * statements do).
 */
export function positionedPdf(items: readonly { x: number; y: number; text: string }[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = ['BT', '/F1 11 Tf', ...items.map((i) => `1 0 0 1 ${i.x} ${i.y} Tm (${esc(i.text)}) Tj`), 'ET'].join('\n');
  return pdfWithContent(content);
}

/** A bank statement header drawn like the real one: all labels first, then all values (fictitious data). */
export const TWO_COLUMN_BANK_PDF_ITEMS = [
  { x: 40, y: 760, text: 'Name: Mr. RAVI KUMAR' },
  { x: 40, y: 740, text: 'CIF Number :' },
  { x: 40, y: 724, text: 'Account No. :' },
  { x: 40, y: 708, text: 'A/c Type :' },
  { x: 320, y: 760, text: 'Branch Name: ANDHERI EAST' },
  { x: 320, y: 740, text: 'IFSC: HDFCO001234' },
  { x: 140, y: 740, text: '81234567890' },
  { x: 140, y: 724, text: '50100234567891' },
  { x: 140, y: 708, text: 'SAVINGS' },
  { x: 320, y: 724, text: 'MICR: 400240002' },
] as const;

