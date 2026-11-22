import sharp from 'sharp';
import type { OcrMode } from './ocr.js';

/*
 * Image preparation for OCR. One Tesseract pass misses fields on real uploads
 * (coloured card backgrounds, small phone photos, table borders), and no single
 * preprocessing wins on all of them, so read.ts tries these passes in order and
 * stops as soon as every expected field is found.
 */

/** Below this width Tesseract's glyphs are too small; enlarging helps small photos but hurts large ones. */
const MIN_OCR_WIDTH = 1500;
const UPSCALE_WIDTH = 2000;

/** Any format sharp decodes (PNG, JPEG, WebP, TIFF, ...) to an upright PNG. Throws when the bytes are not an image. */
export async function normalizeImage(image: Buffer): Promise<Buffer> {
  return sharp(image).rotate().flatten({ background: '#ffffff' }).png().toBuffer();
}

/** Cuts the white margin around a scanned card; a blank image (nothing to trim) is returned as is. */
export async function trimMargins(png: Buffer): Promise<Buffer> {
  try {
    return await sharp(png).trim({ threshold: 20 }).png().toBuffer();
  } catch {
    return png;
  }
}

async function clean(png: Buffer): Promise<Buffer> {
  const trimmed = await trimMargins(png);
  const { width = 0 } = await sharp(trimmed).metadata();
  return sharp(trimmed)
    .resize(width < MIN_OCR_WIDTH ? { width: UPSCALE_WIDTH } : undefined)
    .greyscale()
    .normalise()
    .png()
    .toBuffer();
}

export interface OcrPass {
  name: string;
  mode: OcrMode;
  prepare(png: Buffer): Promise<Buffer>;
}

export const OCR_PASSES: readonly OcrPass[] = [
  { name: 'as-is', mode: 'auto', prepare: async (png) => png },
  // Grey, contrast-stretched, trimmed and enlarged: coloured cards and scans on a page.
  { name: 'clean', mode: 'auto', prepare: clean },
  // Black and white: printed certificates in ruled tables.
  { name: 'binary', mode: 'auto', prepare: async (png) => sharp(await clean(png)).threshold(150).png().toBuffer() },
  // One uniform block: layouts where automatic segmentation splits a label from its value.
  { name: 'clean-block', mode: 'block', prepare: clean },
];

/** Working width for layout analysis: enough for text lines, cheap to rotate many times. */
const LAYOUT_WIDTH = 600;
const MAX_SKEW = 15;

interface Ink {
  data: Buffer;
  width: number;
  height: number;
}

/** A brightness step this large between neighbours is a stroke edge (after stretching contrast to 0-255). */
const EDGE_STEP = 48;

/** A block this size (at LAYOUT_WIDTH) with more than DENSE_SHARE of its pixels on an edge is not text. */
const DENSE_BLOCK = 12;
const DENSE_SHARE = 0.3;
/** Above this share of dense blocks the whole image is texture or noise, and it is scored as it is. */
const MAX_DENSE_AREA = 0.5;

/**
 * Removes blocks that are nearly solid edges: a QR code, barcode, hologram or
 * patterned background. Text never fills a block that densely, and such a
 * block puts the same amount of ink on every row it spans, hiding the gaps
 * between text lines (a PAN card's QR code covers more than half its height,
 * which made a sharp, upright card score as "no text"). Measured on cards:
 * 6-24% of blocks are dense; on noise and texture, 70-100%.
 */
export function withoutDenseBlocks(img: Ink): Ink & { denseArea: number } {
  const { width, height } = img;
  const dense: [number, number][] = [];
  let blocks = 0;
  for (let by = 0; by < height; by += DENSE_BLOCK)
    for (let bx = 0; bx < width; bx += DENSE_BLOCK) {
      let edges = 0;
      let pixels = 0;
      for (let y = by; y < Math.min(by + DENSE_BLOCK, height); y++)
        for (let x = bx; x < Math.min(bx + DENSE_BLOCK, width); x++) {
          pixels++;
          if (img.data[y * width + x]! > 0) edges++;
        }
      blocks++;
      if (edges / pixels > DENSE_SHARE) dense.push([bx, by]);
    }
  const denseArea = blocks ? dense.length / blocks : 0;
  if (dense.length === 0 || denseArea > MAX_DENSE_AREA) return { ...img, denseArea };
  const data = Buffer.from(img.data);
  for (const [bx, by] of dense)
    for (let y = by; y < Math.min(by + DENSE_BLOCK, height); y++) data.fill(0, y * width + bx, y * width + Math.min(bx + DENSE_BLOCK, width));
  return { data, width, height, denseArea };
}

/**
 * Stroke edges as 255 on black, at a small fixed width. Edges rather than dark
 * pixels, so a dark desk, a coloured card or low contrast don't count as ink.
 * Dense blocks (QR codes, patterns) are left out: see withoutDenseBlocks.
 */
async function ink(png: Buffer): Promise<Ink> {
  const grey = await sharp(png).resize({ width: LAYOUT_WIDTH }).greyscale().png().toBuffer();
  const { data: g, info } = await sharp(grey).normalise().extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const data = Buffer.alloc(width * height);
  for (let y = 0; y < height - 1; y++)
    for (let x = 0; x < width - 1; x++) {
      const i = y * width + x;
      if (Math.abs(g[i]! - g[i + 1]!) + Math.abs(g[i]! - g[i + width]!) >= EDGE_STEP) data[i] = 255;
    }
  const { denseArea: _, ...kept } = withoutDenseBlocks({ data, width, height });
  return kept;
}

/** How strongly ink is organised in rows: text lines alternate with empty gaps. */
function lineScore(sums: Float64Array): number {
  let total = 0;
  for (const s of sums) total += s;
  if (total === 0) return 0;
  const mean = total / sums.length;
  let v = 0;
  for (const s of sums) v += (s - mean) ** 2;
  return Math.sqrt(v / sums.length) / mean;
}

function profile(img: Ink, axis: 'rows' | 'cols'): Float64Array {
  const out = new Float64Array(axis === 'rows' ? img.height : img.width);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) if (img.data[y * img.width + x]! > 0) out[axis === 'rows' ? y : x]!++;
  return out;
}

async function rotatedInk(img: Ink, angle: number): Promise<Ink> {
  if (angle === 0) return img;
  const { data, info } = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 1 } })
    .rotate(angle, { background: { r: 0, g: 0, b: 0 } })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export interface Layout {
  /** Degrees to rotate the image by so its text lines are horizontal. */
  skew: number;
  /** Row structure after straightening; near 0 for noise, a photo or a blank page. */
  lines: number;
  /** The same for columns: high when the text runs vertically (a page turned 90 degrees). */
  columns: number;
}

/** Projection profiles: the angle at which rows of ink are sharpest is the one that straightens the text. */
export async function analyseLayout(png: Buffer): Promise<Layout> {
  const img = await ink(png);
  const score = async (a: number) => lineScore(profile(await rotatedInk(img, a), 'rows'));
  let best = 0;
  let bestScore = await score(0);
  for (let a = -MAX_SKEW; a <= MAX_SKEW; a += 1) {
    if (a === 0) continue;
    const s = await score(a);
    if (s > bestScore) [best, bestScore] = [a, s];
  }
  const coarse = best;
  for (let a = coarse - 0.75; a <= coarse + 0.75; a += 0.25) {
    if (a === coarse) continue;
    const s = await score(a);
    if (s > bestScore) [best, bestScore] = [a, s];
  }
  return { skew: best, lines: bestScore, columns: lineScore(profile(img, 'cols')) };
}

/** Rotates by the measured skew; the corners it opens up are filled white like the page. */
export async function straighten(png: Buffer, degrees: number): Promise<Buffer> {
  return sharp(png).rotate(degrees, { background: '#ffffff' }).png().toBuffer();
}

export async function turn(png: Buffer, degrees: 90 | 180 | 270): Promise<Buffer> {
  return sharp(png).rotate(degrees).png().toBuffer();
}

/** Brightness spread below which an image is one flat colour: an empty scan or a blank photo. */
const BLANK_STDEV = 3;

export async function isBlank(png: Buffer): Promise<boolean> {
  const { channels } = await sharp(png).greyscale().stats();
  return channels[0]!.stdev < BLANK_STDEV;
}
