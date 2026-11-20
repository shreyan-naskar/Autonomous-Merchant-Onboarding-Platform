import sharp from 'sharp';

/*
 * Blur detection: variance of the Laplacian. A sharp image has strong edges,
 * so the Laplacian response varies a lot; a blurred one is flat (variance
 * near 0). Calibrated on sample-data/pan-sharp.png / pan-blurry.png
 * (see blur.test.ts); the cut-off is config.thresholds.blur (BLUR_THRESHOLD).
 */

/** 3x3 Laplacian (4-neighbour). */
const LAPLACIAN = [0, 1, 0, 1, -4, 1, 0, 1, 0];
/** Output offset so negative responses survive sharp's 0-255 clamp. */
const OFFSET = 128;
/**
 * Images are scaled to this width first, so the score does not depend on the
 * upload's resolution (a 4000px photo and a 1000px scan of the same card
 * should score alike). Smaller images are not enlarged.
 */
export const BLUR_NORMALIZE_WIDTH = 1000;

/** Laplacian variance of an image (PNG/JPEG bytes). Higher = sharper. */
export async function blurScore(image: Buffer): Promise<number> {
  const { data } = await sharp(image)
    .flatten({ background: '#ffffff' })
    .resize({ width: BLUR_NORMALIZE_WIDTH, withoutEnlargement: true })
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: LAPLACIAN, scale: 1, offset: OFFSET })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]! - OFFSET;
    sum += v;
    sumSq += v * v;
  }
  const n = data.length;
  const mean = sum / n;
  return Math.round((sumSq / n - mean * mean) * 100) / 100;
}

export const isBlurry = (score: number, threshold: number) => score < threshold;
