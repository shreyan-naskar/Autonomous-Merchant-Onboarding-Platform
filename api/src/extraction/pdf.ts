/*
 * PDF text extraction (Phase 7.4) via pdf-parse: reads the PDF's text layer.
 * A scanned PDF (images only) has no text layer and yields '' here; it is
 * then treated as unreadable (no rasterize + OCR step yet).
 */

/** At most this many pages are read: real KYC documents are 1-2 pages. */
export const PDF_MAX_PAGES = 5;

/** The text layer of a PDF, pages joined by newlines. Rejects for bytes that are not a PDF. */
export async function pdfText(file: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(file) });
  try {
    const result = await parser.getText({ first: PDF_MAX_PAGES });
    return result.text;
  } finally {
    await parser.destroy();
  }
}
