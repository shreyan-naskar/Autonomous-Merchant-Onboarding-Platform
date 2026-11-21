/*
 * Rebuilds the text layer row by row from item positions. Bank statements draw
 * two columns column by column, so plain extraction separates every label from
 * its value; grouping by baseline puts them back together, and a wide gap
 * becomes a tab so text.ts knows where a value ends.
 */

import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';

export const PDF_MAX_PAGES = 5;

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

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
      // A gap wider than about two characters is a column break.
      line += gap > Math.max(6, (row[i]!.height || 10) * 1.2) ? '\t' : gap > 1 ? ' ' : '';
      line += row[i]!.str;
    }
    return line.replace(/[  ]+/g, ' ').trim();
  });
}

export async function pdfText(file: Buffer): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // verbosity 0: no warnings about fonts, which text extraction does not need.
  const doc = await getDocument({ data: new Uint8Array(file), verbosity: 0, isEvalSupported: false, disableFontFace: true }).promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, PDF_MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items = content.items
        .filter((i): i is TextItem => 'str' in i)
        .map((i) => ({ str: i.str, x: i.transform[4]!, y: i.transform[5]!, width: i.width, height: i.height }));
      pages.push(itemsToRows(items).join('\n'));
    }
    return pages.join('\n');
  } finally {
    await doc.destroy();
  }
}
