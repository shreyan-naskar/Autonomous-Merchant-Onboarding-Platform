/*
 * Writes the specimen test documents in sample-data/specimens/: a generic
 * layout of this project's own design (no emblem, seal, issuer name or
 * official card or certificate layout), fictional values, and a diagonal
 * "SPECIMEN · TEST DATA · NOT A VALID DOCUMENT" watermark plus a footer
 * line with the same text. Output is deterministic.
 *   npx tsx scripts/generate-specimens.mts
 * api/src/specimens.flow.test.ts reads them through the real pipeline.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { scannedPdf } from '../api/src/extraction/testkit.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'sample-data', 'specimens');

/** One fictional merchant; every provider check passes for these values (see sample-data/README.md). */
export const SPECIMEN = {
  merchant: 'Kaveri Looms Pvt Ltd',
  cardName: 'KAVERI LOOMS PVT LTD',
  mismatchName: 'MEGHA TRADING CO',
  pan: 'AAKCK5678L',
  gstin: '29AAKCK5678L1Z4',
  account: '30210987654321',
  ifsc: 'KKBK0008521',
  date: '02/08/2017',
} as const;

const MARK = 'SPECIMEN · TEST DATA · NOT A VALID DOCUMENT';
const FONT = 'DejaVu Sans, Liberation Sans, Arial, sans-serif';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Light enough for OCR to read through, dark enough to see. */
function watermark(width: number, height: number, size: number): string {
  const angle = (-Math.atan2(height, width) * 180) / Math.PI;
  return `<text x="${width / 2}" y="${height / 2}" font-family="${FONT}" font-size="${size}" font-weight="bold" fill="#000000" fill-opacity="0.07"
    text-anchor="middle" dominant-baseline="middle" transform="rotate(${angle.toFixed(1)} ${width / 2} ${height / 2})">${esc(MARK)}</text>`;
}

function cardSvg(name: string): string {
  const W = 1012;
  const H = 638;
  const field = (y: number, label: string, value: string, size: number, mono = false) => `
    <text x="64" y="${y}" font-size="24" fill="#5c6a64">${esc(label)}</text>
    <text x="64" y="${y + size + 14}" font-size="${size}" font-weight="bold" fill="#111915"${mono ? ' letter-spacing="4"' : ''}>${esc(value)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="28" fill="#fbfcfb" stroke="#c6cfcb" stroke-width="4"/>
  <rect x="10" y="10" width="${W - 20}" height="70" rx="28" fill="#eef2f0"/>
  <rect x="10" y="52" width="${W - 20}" height="28" fill="#eef2f0"/>
  <g font-family="${FONT}">
    <text x="64" y="56" font-size="24" font-weight="bold" fill="#34403b" letter-spacing="3">TAX IDENTITY RECORD</text>
    <text x="${W - 64}" y="56" font-size="22" fill="#5c6a64" text-anchor="end">Record 00417</text>
    ${field(140, 'Permanent Account Number', SPECIMEN.pan, 54, true)}
    ${field(290, 'Name', name, 42)}
    ${field(430, 'Date of incorporation', SPECIMEN.date, 34)}
    <rect x="${W - 240}" y="130" width="176" height="210" rx="12" fill="none" stroke="#c6cfcb" stroke-width="3" stroke-dasharray="10 8"/>
    <text x="${W - 152}" y="242" font-size="20" fill="#93a09a" text-anchor="middle">NO PHOTO</text>
    <text x="64" y="${H - 40}" font-size="20" fill="#5c6a64">${esc(MARK)}</text>
    ${watermark(W, H, 38)}
  </g>
</svg>`;
}

/** An A4 page of label/value rows, as a reader sees it (also rendered for the scanned variant). */
function pageSvg(title: string, rows: [string, string][]): string {
  const W = 1240;
  const H = 1754;
  const body = rows
    .map(([label, value], i) => {
      const y = 330 + i * 70;
      return `<text x="110" y="${y}" font-size="30" fill="#34403b">${esc(label)}: <tspan font-weight="bold" fill="#111915">${esc(value)}</tspan></text>`;
    })
    .join('\n    ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <g font-family="${FONT}">
    <text x="110" y="170" font-size="44" font-weight="bold" fill="#111915">${esc(title)}</text>
    <line x1="110" y1="215" x2="${W - 110}" y2="215" stroke="#c6cfcb" stroke-width="3"/>
    ${body}
    <text x="110" y="${H - 110}" font-size="24" fill="#5c6a64">${esc(MARK)}</text>
    ${watermark(W, H, 64)}
  </g>
</svg>`;
}

const GST_TITLE = 'GST registration record';
const GST_ROWS: [string, string][] = [
  ['Registration Number', SPECIMEN.gstin],
  ['Legal Name', SPECIMEN.merchant],
  ['Constitution of Business', 'Private Limited Company'],
  ['Date of liability', '01/04/2018'],
];
const BANK_TITLE = 'Bank account confirmation';
const BANK_ROWS: [string, string][] = [
  ['Account Holder Name', SPECIMEN.merchant],
  ['Account Number', SPECIMEN.account],
  ['IFSC', SPECIMEN.ifsc],
  ['Account type', 'Current'],
];

/** A one-page PDF with a Helvetica text layer and a light diagonal watermark. Hand-built: no PDF library. */
function textLayerPdf(title: string, rows: [string, string][]): Buffer {
  const pdfEsc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const lines = [title, '', ...rows.map(([l, v]) => `${l}: ${v}`)];
  const cos = Math.cos(Math.PI / 5).toFixed(4);
  const sin = Math.sin(Math.PI / 5).toFixed(4);
  const content = [
    'q 0.92 g BT /F1 30 Tf',
    `${cos} ${sin} -${sin} ${cos} 90 240 Tm (${pdfEsc(MARK)}) Tj`,
    'ET Q',
    'BT /F1 14 Tf 22 TL 72 770 Td',
    ...lines.map((l) => `(${pdfEsc(l)}) Tj T*`),
    'ET',
    `BT /F1 9 Tf 0.4 g 72 48 Td (${pdfEsc(MARK)}) Tj ET`,
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const png = (svg: string) => sharp(Buffer.from(svg)).flatten({ background: '#ffffff' }).png().toBuffer();

async function main() {
  mkdirSync(out, { recursive: true });
  const card = await png(cardSvg(SPECIMEN.cardName));
  await sharp(card).toFile(join(out, 'pan-specimen.png'));
  await sharp(card).blur(6).png().toFile(join(out, 'pan-specimen-blurry.png'));
  await sharp(card).rotate(7, { background: '#ffffff' }).jpeg({ quality: 88 }).toFile(join(out, 'pan-specimen-tilted.jpg'));
  await sharp(await png(cardSvg(SPECIMEN.mismatchName))).toFile(join(out, 'pan-specimen-name-mismatch.png'));

  writeFileSync(join(out, 'gst-specimen.pdf'), textLayerPdf(GST_TITLE, GST_ROWS));
  writeFileSync(join(out, 'bank-specimen.pdf'), textLayerPdf(BANK_TITLE, BANK_ROWS));

  const scan = await sharp(await png(pageSvg(GST_TITLE, GST_ROWS))).jpeg({ quality: 80 }).toBuffer();
  const { width = 0, height = 0 } = await sharp(scan).metadata();
  writeFileSync(join(out, 'gst-specimen-scanned.pdf'), scannedPdf(scan, { width, height }, { widthPt: 560 }));

  console.log('wrote sample-data/specimens/: pan-specimen.png, pan-specimen-blurry.png, pan-specimen-tilted.jpg, pan-specimen-name-mismatch.png, gst-specimen.pdf, gst-specimen-scanned.pdf, bank-specimen.pdf');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
