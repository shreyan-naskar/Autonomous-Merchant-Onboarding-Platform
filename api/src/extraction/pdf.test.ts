import { describe, expect, it } from 'vitest';
import { itemsToRows, pdfText } from './pdf.js';
import { positionedPdf, TWO_COLUMN_BANK_PDF_ITEMS } from './testkit.js';

const item = (str: string, x: number, y: number, width = str.length * 5, height = 10) => ({ str, x, y, width, height });

describe('itemsToRows', () => {
  it('orders by baseline then x, whatever the drawing order', () => {
    const rows = itemsToRows([item('value-b', 140, 724), item('Label A :', 40, 740), item('Label B :', 40, 724), item('value-a', 140, 740)]);
    expect(rows).toEqual(['Label A :\tvalue-a', 'Label B :\tvalue-b']);
  });

  it('small gaps join with a space or nothing, wide gaps with a tab; near baselines share a row', () => {
    const rows = itemsToRows([item('Account', 40, 700, 35), item('No.', 77, 700.5, 15), item('12345', 92, 701, 25), item('MICR', 320, 700, 20)]);
    expect(rows).toEqual(['Account No.12345\tMICR']);
  });

  it('text drawn over other text (an edited PDF) is kept apart with a tab', () => {
    expect(itemsToRows([item('19FJBPS6993J1ZY', 140, 700, 80), item('19FOBPS6993J1ZY', 141, 700, 80)])).toEqual(['19FJBPS6993J1ZY\t19FOBPS6993J1ZY']);
  });

  it('drops empty items', () => {
    expect(itemsToRows([item(' ', 10, 10), item('x', 20, 10)])).toEqual(['x']);
  });
});

describe('pdfText', () => {
  it('a PDF drawn column by column comes back as label/value rows', async () => {
    const { text, overlapping } = await pdfText(positionedPdf(TWO_COLUMN_BANK_PDF_ITEMS));
    expect(overlapping).toBe(false);
    const lines = text.split('\n');
    expect(lines.find((l) => l.startsWith('Account No.'))).toMatch(/^Account No\. :\s+50100234567891\tMICR: 400240002$/);
    expect(lines.find((l) => l.startsWith('CIF Number'))).toMatch(/81234567890\tIFSC: HDFCO001234$/);
  });

  it('flags text drawn on top of other text', async () => {
    const { overlapping } = await pdfText(positionedPdf([{ x: 140, y: 700, text: 'OLD VALUE' }, { x: 141, y: 700, text: 'NEW VALUE' }]));
    expect(overlapping).toBe(true);
  });

  it('rejects bytes that are not a PDF', async () => {
    await expect(pdfText(Buffer.from('not a pdf'))).rejects.toThrow();
  });
});
