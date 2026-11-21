import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { DOCUMENT_TYPES, type DocumentType } from '@app/shared';
import { blurScore, isBlurry } from './blur.js';
import type { OcrEngine } from './ocr.js';
import { pdfText } from './pdf.js';
import { parseDocumentText } from './text.js';

/* The slow part of extraction (blur check, OCR, PDF text). Runs in the extract job, never in a request, before its DB transaction. */

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

export interface ReadDeps {
  ocr: OcrEngine;
  blurThreshold: number;
  readFile?: (path: string) => Promise<Buffer>;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const PDF_EXTENSION = '.pdf';

const isDocumentType = (t: string): t is DocumentType => (DOCUMENT_TYPES as readonly string[]).includes(t);

async function readImage(type: DocumentType, file: Buffer, deps: ReadDeps): Promise<DocumentReading> {
  let score: number;
  try {
    score = await blurScore(file);
  } catch {
    // Corrupt or mislabelled: deterministic, so not worth a retry.
    return { source: 'ocr', payload: null, confidence: 0, error: 'not_an_image' };
  }
  if (isBlurry(score, deps.blurThreshold)) {
    return { source: 'ocr', payload: null, confidence: 0, blurScore: score, blurry: true };
  }
  // OCR errors (e.g. model download failed) propagate: the worker retries the job.
  const { text, confidence, words } = await deps.ocr.recognize(file);
  const payload = parseDocumentText(type, text);
  const fieldConfidence = words?.length
    ? Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, valueConfidence(v, words, confidence)]))
    : undefined;
  return { source: 'ocr', payload, confidence, ...(fieldConfidence ? { fieldConfidence } : {}), blurScore: score, blurry: false };
}

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

async function readPdf(type: DocumentType, file: Buffer): Promise<DocumentReading> {
  let text: string;
  try {
    text = await pdfText(file);
  } catch {
    return { source: 'pdf', payload: null, confidence: 0, error: 'not_a_pdf' };
  }
  if (text.replace(/-- \d+ of \d+ --/g, '').trim() === '') {
    // A scan (images only): rasterize + OCR is not implemented.
    return { source: 'pdf', payload: null, confidence: 0, error: 'no_text_layer' };
  }
  return { source: 'pdf', payload: parseDocumentText(type, text), confidence: PDF_TEXT_CONFIDENCE };
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
    out.set(d.id, source === 'pdf' ? await readPdf(d.type, file) : await readImage(d.type, file, deps));
  }
  return out;
}
