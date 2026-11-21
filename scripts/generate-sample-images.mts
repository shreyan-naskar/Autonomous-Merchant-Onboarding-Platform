/*
 * Generates the sample document files in sample-data/:
 *   pan-sharp.png   a clean, synthetic PAN card (OCR-readable)
 *   pan-blurry.png  the same card with a Gaussian blur (fails the blur check)
 *   gst-cert.pdf    a text-layer GST certificate (pdf-parse, no OCR)
 *   bank-proof.pdf  a text-layer bank letter
 *   missing-gst-cert.pdf  the GST certificate missing.json lacks (upload it
 *                   in the "Information needed" panel to complete that app)
 *
 * The card is fake: it uses the identity of sample-data/ocr-pan.json, not a
 * real person or company. Run from the repo root:
 *   npx tsx scripts/generate-sample-images.mts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { SAMPLE_BANK_PROOF, SAMPLE_GST_CERT, textPdf } from '../api/src/extraction/testkit.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'sample-data');

export const SAMPLE_CARD = {
  pan: 'AAFCS4321M',
  name: 'SUNRISE TRADERS PVT LTD',
  date: '14/03/2019',
} as const;

function cardSvg({ pan, name, date }: typeof SAMPLE_CARD): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1012" height="638">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="12" y="12" width="988" height="614" rx="24" fill="none" stroke="#1f3a68" stroke-width="6"/>
  <g font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" fill="#111111">
    <text x="60" y="90" font-size="40" font-weight="bold">INCOME TAX DEPARTMENT</text>
    <text x="60" y="140" font-size="28">SAMPLE DOCUMENT - NOT VALID</text>
    <text x="60" y="225" font-size="28">Permanent Account Number</text>
    <text x="60" y="290" font-size="56" font-weight="bold" letter-spacing="4">${pan}</text>
    <text x="60" y="375" font-size="28">Name</text>
    <text x="60" y="430" font-size="44" font-weight="bold">${name}</text>
    <text x="60" y="515" font-size="28">Date of Incorporation</text>
    <text x="60" y="565" font-size="36">${date}</text>
  </g>
</svg>`;
}

async function main() {
  mkdirSync(out, { recursive: true });
  const base = sharp(Buffer.from(cardSvg(SAMPLE_CARD))).flatten({ background: '#ffffff' });
  const sharpPng = await base.clone().png().toBuffer();
  await sharp(sharpPng).toFile(join(out, 'pan-sharp.png'));
  await sharp(sharpPng).blur(6).png().toFile(join(out, 'pan-blurry.png'));
  writeFileSync(join(out, 'gst-cert.pdf'), textPdf(SAMPLE_GST_CERT));
  writeFileSync(join(out, 'bank-proof.pdf'), textPdf(SAMPLE_BANK_PROOF));
  writeFileSync(
    join(out, 'missing-gst-cert.pdf'),
    textPdf([
      'Government of India - Form GST REG-06',
      'SAMPLE DOCUMENT - NOT VALID',
      'Registration Certificate',
      'Registration Number: 33AAECS3456R1Z1',
      'Legal Name: Sunrise Bakery',
      'Constitution of Business: Proprietorship',
    ]),
  );
  console.log('wrote sample-data/pan-sharp.png, pan-blurry.png, gst-cert.pdf, bank-proof.pdf, missing-gst-cert.pdf');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
