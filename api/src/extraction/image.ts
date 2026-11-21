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
