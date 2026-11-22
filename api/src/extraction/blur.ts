import sharp from 'sharp';

/* Variance of the Laplacian: sharp edges vary a lot, a blurred image is flat. Calibrated in blur.test.ts. */

const LAPLACIAN = [0, 1, 0, 1, -4, 1, 0, 1, 0];
/** Output offset so negative responses survive sharp's 0-255 clamp. */
const OFFSET = 128;
/** Scaling first keeps the score independent of the upload's resolution. */
const BLUR_NORMALIZE_WIDTH = 1000;

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
