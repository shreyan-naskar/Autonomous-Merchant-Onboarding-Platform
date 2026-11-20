import type { OcrEngine } from './ocr.js';

/** Test fixtures for OCR (not imported by production code). */

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
