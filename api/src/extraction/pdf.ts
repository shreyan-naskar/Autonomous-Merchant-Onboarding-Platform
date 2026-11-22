/*
 * Rebuilds the text layer row by row from item positions. Bank statements draw
 * two columns column by column, so plain extraction separates every label from
 * its value; grouping by baseline puts them back together, and a wide gap
 * becomes a tab so text.ts knows where a value ends.
 */

import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';

const PDF_MAX_PAGES = 5;

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Text drawn over other text, as an edited PDF leaves it: the old value is still there, hidden under a white box. */
const overlaps = (prev: Item, next: Item) => next.x < prev.x + prev.width - Math.max(2, (next.height || 10) * 0.5);

export function itemsToRows(items: readonly Item[]): string[] {
  const sorted = items.filter((i) => i.str.trim() !== '').sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Item[][] = [];
  for (const it of sorted) {
    const row = rows.at(-1);
    // Same row when the baselines are within half a line height.
    if (row && Math.abs(row[0]!.y - it.y) <= Math.max(2, (it.height || 10) * 0.5)) row.push(it);
    else rows.push([it]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    let line = row[0]!.str;
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1]!;
      const gap = row[i]!.x - (prev.x + prev.width);
      // A gap wider than about two characters is a column break; overlapping text is kept apart the same way.
      line += gap > Math.max(6, (row[i]!.height || 10) * 1.2) || overlaps(prev, row[i]!) ? '\t' : gap > 1 ? ' ' : '';
      line += row[i]!.str;
    }
    return line.replace(/[ \u00a0]+/g, ' ').trim();
  });
}

async function openPdf(file: Buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // verbosity 0: no warnings about fonts, which neither text extraction nor a scan's image needs.
  return getDocument({ data: new Uint8Array(file), verbosity: 0, isEvalSupported: false, disableFontFace: true }).promise;
}

/** pdfjs refuses an encrypted PDF without its password with this error. */
export const isPasswordError = (err: unknown) => err instanceof Error && err.name === 'PasswordException';

export interface PdfText {
  text: string;
  /** Some text is drawn over other text, so the layer holds values a reader cannot see. */
  overlapping: boolean;
}

/** Two text runs on the same baseline that share more than half of the shorter one's width. */
function sameSpot(a: Item, b: Item): boolean {
  if (Math.abs(a.y - b.y) > Math.max(2, (a.height || 10) * 0.5)) return false;
  const shared = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  return shared > Math.min(a.width, b.width) * 0.5;
}

export async function pdfText(file: Buffer): Promise<PdfText> {
  const doc = await openPdf(file);
  try {
    const pages: string[] = [];
    let overlapping = false;
    for (let n = 1; n <= Math.min(doc.numPages, PDF_MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items = content.items
        .filter((i): i is TextItem => 'str' in i)
        .map((i) => ({ str: i.str, x: i.transform[4]!, y: i.transform[5]!, width: i.width, height: i.height }));
      pages.push(itemsToRows(items).join('\n'));
      overlapping ||= items.some((a, i) => items.some((b, j) => j > i && a.str.trim() !== '' && b.str.trim() !== '' && sameSpot(a, b)));
    }
    return { text: pages.join('\n'), overlapping };
  } finally {
    await doc.destroy();
  }
}

/** Long side of a rendered page: about 240 dpi on A4, enough for OCR of a card scanned onto the page. */
const RENDER_LONG_SIDE = 2800;

/** The factory pdfjs creates in Node; its type is not exported. */
interface NodeCanvasFactory {
  create(width: number, height: number): { canvas: HTMLCanvasElement & { toBuffer(type: 'image/png'): Buffer }; context: CanvasRenderingContext2D };
}

/** Each page as a PNG, for OCR of scanned PDFs. pdfjs draws on @napi-rs/canvas in Node. */
export async function pdfPageImages(file: Buffer, maxPages = PDF_MAX_PAGES): Promise<Buffer[]> {
  const doc = await openPdf(file);
  try {
    const images: Buffer[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: RENDER_LONG_SIDE / Math.max(base.width, base.height) });
      const { canvas, context } = (doc.canvasFactory as NodeCanvasFactory).create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      images.push(canvas.toBuffer('image/png'));
      page.cleanup();
    }
    return images;
  } finally {
    await doc.destroy();
  }
}
