import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { blurScore, isBlurry } from './blur.js';

const SAMPLE_DIR = fileURLToPath(new URL('../../../sample-data/', import.meta.url));
const SHARP = readFileSync(join(SAMPLE_DIR, 'pan-sharp.png'));
const BLURRY = readFileSync(join(SAMPLE_DIR, 'pan-blurry.png'));
const THRESHOLD = loadConfig({}).thresholds.blur;

describe('blurScore (Laplacian variance) calibration on the sample PAN cards', () => {
  it('scores the sharp sample far above the default threshold and the blurry one far below', async () => {
    const sharpScore = await blurScore(SHARP);
    const blurryScore = await blurScore(BLURRY);
    expect(sharpScore).toBeGreaterThan(THRESHOLD * 10);
    expect(blurryScore).toBeLessThan(THRESHOLD / 10);
    expect(isBlurry(sharpScore, THRESHOLD)).toBe(false);
    expect(isBlurry(blurryScore, THRESHOLD)).toBe(true);
  });

  it('decreases monotonically as blur increases', async () => {
    const scores = [];
    for (const sigma of [1, 2, 3, 5]) scores.push(await blurScore(await sharp(SHARP).blur(sigma).png().toBuffer()));
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThan(scores[i - 1]!);
  });

  it('is not fooled by resolution or JPEG re-encoding', async () => {
    const base = await blurScore(SHARP);
    const upscaled = await blurScore(await sharp(SHARP).resize(2024).png().toBuffer());
    const jpeg = await blurScore(await sharp(SHARP).jpeg({ quality: 70 }).toBuffer());
    expect(isBlurry(upscaled, THRESHOLD)).toBe(false);
    expect(isBlurry(jpeg, THRESHOLD)).toBe(false);
    expect(upscaled / base).toBeGreaterThan(0.5);
  });

  it('a blank page has no edges: score 0', async () => {
    const blank = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } }).png().toBuffer();
    expect(await blurScore(blank)).toBe(0);
  });

  it('rejects bytes that are not an image', async () => {
    await expect(blurScore(Buffer.from('%PDF-1.4 not an image'))).rejects.toThrow();
  });
});
