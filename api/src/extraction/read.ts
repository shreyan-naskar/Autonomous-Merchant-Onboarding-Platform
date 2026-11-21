import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { DOCUMENT_TYPES, type DocumentType } from '@app/shared';
import { blurScore, isBlurry } from './blur.js';
import { DOCUMENT_FIELDS } from './extract.js';
import { normalizeImage, OCR_PASSES, trimMargins } from './image.js';
import type { OcrEngine } from './ocr.js';
import { pdfPageImages, pdfText } from './pdf.js';
import { parseDocumentText } from './text.js';

/* The slow part of extraction (blur check, OCR, PDF text, OCR of scanned pages). Runs in the extract job, never in a request, before its DB transaction. */

export interface DocumentReading {
  source: 'ocr' | 'pdf';
  payload: Record<string, string> | null;
  /** Fallback for fields without their own word-level confidence. */
  confidence: number;
  /** Per field: the OCR confidence of its own words. The page mean is dragged down by everything else on a real card. */
  fieldConfidence?: Record<string, number>;
  blurScore?: number;
  blurry?: boolean;
  error?: 'file_unreadable' | 'not_an_image' | 'not_a_pdf' | 'no_text_layer';
}

/** Exact text, but the label parsing is a heuristic: just below JSON (1.0), above the 0.8 threshold. */
export const PDF_TEXT_CONFIDENCE = 0.95;

export interface ReadableDocument {
  id: number;
  type: string;
  payload: unknown;
  path: string | null;
}

interface ReadDeps {
  ocr: OcrEngine;
  blurThreshold: number;
  readFile?: (path: string) => Promise<Buffer>;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']);
const PDF_EXTENSION = '.pdf';

const isDocumentType = (t: string): t is DocumentType => (DOCUMENT_TYPES as readonly string[]).includes(t);

const expectedKeys = (type: DocumentType) => DOCUMENT_FIELDS[type].map((f) => f.key);

interface OcrRead {
  payload: Record<string, string>;
  /** The first pass's page confidence. */
  confidence: number;
  fieldConfidence: Record<string, number>;
}

/**
 * OCR passes in order (image.ts) until every expected field is found. A field
 * keeps the value and word confidence of the first pass that found it, and
 * fields already in `have` (e.g. from a PDF text layer) are not overwritten.
 * OCR errors (e.g. model download failed) propagate: the worker retries the job.
 */
async function ocrFields(type: DocumentType, png: Buffer, ocr: OcrEngine, have: Record<string, string> = {}): Promise<OcrRead> {
  const want = expectedKeys(type);
  const out: OcrRead = { payload: {}, confidence: 0, fieldConfidence: {} };
  for (const [i, pass] of OCR_PASSES.entries()) {
    const { text, confidence, words } = await ocr.recognize(await pass.prepare(png), pass.mode);
    if (i === 0) out.confidence = confidence;
    for (const [k, v] of Object.entries(parseDocumentText(type, text))) {
      if (k in out.payload || k in have) continue;
      out.payload[k] = v;
      out.fieldConfidence[k] = words?.length ? valueConfidence(v, words, confidence) : confidence;
    }
    if (want.every((k) => k in out.payload || k in have)) break;
  }
  return out;
}

async function readImage(type: DocumentType, file: Buffer, deps: ReadDeps): Promise<DocumentReading> {
  let png: Buffer;
  let score: number;
  try {
    png = await normalizeImage(file);
    score = await blurScore(png);
  } catch {
    // Corrupt or mislabelled: deterministic, so not worth a retry.
    return { source: 'ocr', payload: null, confidence: 0, error: 'not_an_image' };
  }
  if (isBlurry(score, deps.blurThreshold)) {
    return { source: 'ocr', payload: null, confidence: 0, blurScore: score, blurry: true };
  }
  const { payload, confidence, fieldConfidence } = await ocrFields(type, png, deps.ocr);
  return { source: 'ocr', payload, confidence, ...withFieldConfidence(fieldConfidence), blurScore: score, blurry: false };
}

const withFieldConfidence = (fc: Record<string, number>) => (Object.keys(fc).length > 0 ? { fieldConfidence: fc } : {});

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0');

/** The weakest of the value's words; the page confidence when a word can't be matched (e.g. normalized after OCR). */
export function valueConfidence(value: string, words: readonly { text: string; confidence: number }[], fallback: number): number {
  let min = 1;
  for (const token of value.split(/\s+/).map(norm).filter(Boolean)) {
    const matches = words.filter((w) => norm(w.text) === token);
    if (matches.length === 0) return fallback;
    min = Math.min(min, Math.max(...matches.map((w) => w.confidence)));
  }
  return Math.round(min * 100) / 100;
}

/**
 * The text layer first. When it lacks expected fields (a scan, or a scan with
 * only a typed header) the pages are rendered and OCR'd for the rest; text
 * layer values always win. Blurry pages are not OCR'd, and when a scan has
 * nothing but blurry pages the document is blurry, like an image upload.
 */
async function readPdf(type: DocumentType, file: Buffer, deps: ReadDeps): Promise<DocumentReading> {
  let text: string;
  try {
    text = await pdfText(file);
  } catch {
    return { source: 'pdf', payload: null, confidence: 0, error: 'not_a_pdf' };
  }
  const hasText = text.trim() !== '';
  const fromText = hasText ? parseDocumentText(type, text) : {};
  const want = expectedKeys(type);
  if (want.every((k) => k in fromText)) return { source: 'pdf', payload: fromText, confidence: PDF_TEXT_CONFIDENCE };

  let pages: Buffer[];
  try {
    pages = await pdfPageImages(file);
  } catch {
    pages = [];
  }
  const payload = { ...fromText };
  const fieldConfidence: Record<string, number> = Object.fromEntries(Object.keys(fromText).map((k) => [k, PDF_TEXT_CONFIDENCE]));
  let ocrConfidence: number | undefined;
  let scanned = 0;
  let blurryScore: number | undefined;
  for (const page of pages) {
    const png = await trimMargins(page);
    const score = await blurScore(png);
    // A blank page has no edges at all: nothing to read, and not a blurry scan.
    if (score === 0) continue;
    scanned++;
    if (isBlurry(score, deps.blurThreshold)) {
      blurryScore = Math.max(blurryScore ?? 0, score);
      continue;
    }
    const read = await ocrFields(type, png, deps.ocr, payload);
    ocrConfidence ??= read.confidence;
    Object.assign(payload, read.payload);
    Object.assign(fieldConfidence, read.fieldConfidence);
    if (want.every((k) => k in payload)) break;
  }

  if (!hasText && ocrConfidence === undefined) {
    if (blurryScore !== undefined && scanned > 0) {
      return { source: 'pdf', payload: null, confidence: 0, blurScore: blurryScore, blurry: true };
    }
    return { source: 'pdf', payload: null, confidence: 0, error: 'no_text_layer' };
  }
  const confidence = hasText ? PDF_TEXT_CONFIDENCE : ocrConfidence!;
  return { source: 'pdf', payload, confidence, ...withFieldConfidence(ocrConfidence === undefined ? {} : fieldConfidence) };
}


export async function readUploadedDocuments(
  docs: readonly ReadableDocument[],
  deps: ReadDeps,
): Promise<Map<number, DocumentReading>> {
  const read = deps.readFile ?? ((p: string) => readFile(p));
  const out = new Map<number, DocumentReading>();
  for (const d of docs) {
    if (d.payload != null || !d.path || !isDocumentType(d.type)) continue;
    const ext = extname(d.path).toLowerCase();
    const source = ext === PDF_EXTENSION ? 'pdf' : IMAGE_EXTENSIONS.has(ext) ? 'ocr' : undefined;
    if (!source) continue;
    let file: Buffer;
    try {
      file = await read(d.path);
    } catch {
      out.set(d.id, { source, payload: null, confidence: 0, error: 'file_unreadable' });
      continue;
    }
    out.set(d.id, source === 'pdf' ? await readPdf(d.type, file, deps) : await readImage(d.type, file, deps));
  }
  return out;
}
