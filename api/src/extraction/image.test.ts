import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SAMPLE_DIR } from '../testing.js';
import { analyseLayout, isBlank } from './image.js';
import { MIN_TEXT_LINES } from './read.js';

const card = readFileSync(join(SAMPLE_DIR, 'pan-sharp.png'));
const tilted = (deg: number) => sharp(card).rotate(deg, { background: '#ffffff' }).png().toBuffer();

describe('analyseLayout', () => {
  it.each([3, 6, -8, 12])('measures a %i degree tilt (to within half a degree), as the rotation that undoes it', async (deg) => {
    const { skew } = await analyseLayout(await tilted(deg));
    expect(Math.abs(skew + deg)).toBeLessThanOrEqual(0.5);
  });

  it('a straight card has no skew and clear text rows', async () => {
    const l = await analyseLayout(card);
    expect(l.skew).toBe(0);
    expect(l.lines).toBeGreaterThan(MIN_TEXT_LINES);
  });

  it('a card on its side: the text runs in columns', async () => {
    const l = await analyseLayout(await sharp(card).rotate(90).png().toBuffer());
    expect(l.columns).toBeGreaterThan(l.lines);
    expect(l.columns).toBeGreaterThan(MIN_TEXT_LINES);
  });

  it('a smooth photo with no text has no rows of text', async () => {
    // Random colours, enlarged and blurred into soft blobs: shapes and shading but no rows of marks.
    const px = Buffer.alloc(80 * 60 * 3);
    let seed = 7;
    for (let i = 0; i < px.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      px[i] = seed & 0xff;
    }
    const photo = await sharp(px, { raw: { width: 80, height: 60, channels: 3 } }).resize(1200, 900).blur(8).png().toBuffer();
    const l = await analyseLayout(photo);
    expect(Math.max(l.lines, l.columns)).toBeLessThan(MIN_TEXT_LINES);
  });
});

describe('isBlank', () => {
  it('a white page is blank; the card is not', async () => {
    expect(await isBlank(await sharp({ create: { width: 400, height: 300, channels: 3, background: '#fefefe' } }).png().toBuffer())).toBe(true);
    expect(await isBlank(card)).toBe(false);
  });
});
