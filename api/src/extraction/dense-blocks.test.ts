import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE_DIR } from '../testing.js';
import { analyseLayout } from './image.js';
import type { OcrEngine } from './ocr.js';
import { MIN_TEXT_LINES, NO_TEXT_LINES, readUploadedDocuments } from './read.js';
import { fakeOcr, PAN_SHARP_OCR_TEXT } from './testkit.js';

/*
 * A real, sharp, upright PAN card photo was rejected as "no text found": its
 * QR code and security print put edges on every row, so the row score was
 * 0.86 against the 0.9 cutoff (and the tilt read as -15.75 degrees). Dense
 * blocks are now left out of the score, and a score between NO_TEXT_LINES
 * and MIN_TEXT_LINES is settled by OCR instead of rejected outright.
 */

const card = readFileSync(join(SAMPLE_DIR, 'pan-sharp.png'));

/** Random black and white modules, like a QR code. */
async function qr(size: number, modules = 33): Promise<Buffer> {
  const px = Buffer.alloc(modules * modules);
  let seed = 11;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = seed & 0x100 ? 0 : 255;
  }
  return sharp(px, { raw: { width: modules, height: modules, channels: 1 } }).resize(size, size, { kernel: 'nearest' }).png().toBuffer();
}

/** Fine wavy lines over the whole card, like a security print. */
const securityPrint = (w: number, h: number, gap: number, opacity: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${Array.from(
      { length: Math.ceil((w + h) / gap) },
      (_, i) => `<path d="M ${i * gap - h} ${h} Q ${i * gap - h / 2} 0 ${i * gap} ${h}" stroke="#334" stroke-opacity="${opacity}" stroke-width="1.5" fill="none"/>`,
    ).join('')}</svg>`,
  );

/** The sample card with a QR code beside the text (qr: share of the card's height) and a security print over everything. */
async function printedCard(qrHeight: number, gap: number, opacity: number): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(card).metadata();
  const size = Math.round(height * qrHeight);
  return sharp(card)
    .extend({ right: size + 40, background: '#ffffff' })
    .composite([
      { input: securityPrint(width + size + 40, height, gap, opacity), left: 0, top: 0, blend: 'multiply' },
      { input: await qr(size), left: width + 20, top: Math.round((height - size) / 2) },
    ])
    .png()
    .toBuffer();
}

function noise(width: number, height: number, seed: number): Promise<Buffer> {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = seed & 0xff;
  }
  return sharp(px, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('analyseLayout leaves out QR codes and other dense patterns', () => {
  it('a card with a tall QR code and a security print has clear text rows and no tilt (0.79 and -11.5 degrees before)', async () => {
    const l = await analyseLayout(await printedCard(0.75, 10, 0.35));
    expect(l.lines).toBeGreaterThan(MIN_TEXT_LINES);
    expect(l.skew).toBe(0);
  });

  it('a tilt is still measured on such a card', async () => {
    const l = await analyseLayout(await sharp(await printedCard(0.75, 10, 0.35)).rotate(6, { background: '#ffffff' }).png().toBuffer());
    expect(Math.abs(l.skew + 6)).toBeLessThanOrEqual(0.5);
  });

  it.each([
    [800, 600, 42],
    [1200, 900, 9],
  ])('noise (%ix%i) is dense throughout, so nothing is left out, and it has no rows of text', async (w, h, seed) => {
    const l = await analyseLayout(await noise(w, h, seed));
    expect(Math.max(l.lines, l.columns)).toBeLessThan(NO_TEXT_LINES);
  });
});

describe('an unclear layout is settled by OCR, not rejected', () => {
  let unclear: Buffer;
  beforeAll(async () => {
    // A security print so dense that most of the card counts as pattern: the layout cannot tell.
    unclear = await printedCard(0.6, 8, 0.4);
  });
  const read = async (ocr: OcrEngine) =>
    (await readUploadedDocuments([{ id: 1, type: 'PAN_CARD', payload: null, path: '/u/card.png' }], { ocr, blurThreshold: 30, readFile: async () => unclear })).get(1)!;

  it('the test card scores between the two cutoffs', async () => {
    const l = await analyseLayout(unclear);
    expect(Math.max(l.lines, l.columns)).toBeGreaterThanOrEqual(NO_TEXT_LINES);
    expect(Math.max(l.lines, l.columns)).toBeLessThan(MIN_TEXT_LINES);
  });

  it('OCR finds the fields: the card is read', async () => {
    const ocr = fakeOcr();
    const r = await read(ocr);
    expect(r.error).toBeUndefined();
    expect(r.payload).toMatchObject({ pan: expect.any(String), name: expect.any(String) });
    expect(ocr.calls).toBeGreaterThan(0);
    expect(PAN_SHARP_OCR_TEXT).toContain(r.payload!.pan);
  });

  it('OCR makes no sense of it in any orientation: "no_text"', async () => {
    const ocr = fakeOcr('~~ ._ ;; ,, ::', 0.2);
    expect(await read(ocr)).toMatchObject({ payload: null, error: 'no_text' });
    expect(ocr.calls).toBe(4);
  });
});
