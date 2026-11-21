import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { DOCUMENT_TYPES, type DocumentType } from '@app/shared';
import { blurScore, isBlurry } from './blur.js';
import type { OcrEngine } from './ocr.js';
import { pdfText } from './pdf.js';
import { parseDocumentText } from './text.js';

/*
 * Reads uploaded files (the slow, async part of extraction: blur check + OCR
 * for images, text layer for PDFs) into structured payloads that
 * extractFields() treats like JSON documents. Runs in the extract job only,
 * before its DB transaction.
 */

export interface DocumentReading {
  /** ocr: image through blur check + tesseract; pdf: the PDF's text layer. */
  source: 'ocr' | 'pdf';
  /** Parsed values, or null when nothing could be read (blurry, corrupt, no text layer, unreadable file). */
  payload: Record<string, string> | null;
  /** Confidence of the read (OCR page mean, or PDF_TEXT_CONFIDENCE), 0-1. Used for fields without their own. */
  confidence: number;
  /** Per payload key: OCR confidence of the words that make up that value (images only). */
  fieldConfidence?: Record<string, number>;
  blurScore?: number;
  blurry?: boolean;
  /** Why the file could not be read (no values, never file contents). */
  error?: 'file_unreadable' | 'not_an_image' | 'not_a_pdf' | 'no_text_layer';
}

/**
 * A PDF text layer is exact text, not a recognition, but the label-based
 * parsing is still a heuristic: just below structured JSON (1.0), well above
 * the 0.8 review threshold.
 */
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
    // sharp could not decode it: corrupt or mislabelled. Not worth a retry.
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

/** Comparable form of a word: upper case, letters and digits only, O read as 0. */
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0');

/**
 * Confidence of one extracted value: the lowest confidence among its words,
 * each matched to the best-scoring OCR word with the same text. Falls back
 * to the page confidence when a word cannot be found (e.g. the value was
 * normalized after OCR).
 */
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
    // Corrupt or not a PDF: deterministic, so not worth a retry.
    return { source: 'pdf', payload: null, confidence: 0, error: 'not_a_pdf' };
  }
  if (text.replace(/-- \d+ of \d+ --/g, '').trim() === '') {
    // A scanned PDF: images only. Rasterize + OCR is not implemented.
    return { source: 'pdf', payload: null, confidence: 0, error: 'no_text_layer' };
  }
  return { source: 'pdf', payload: parseDocumentText(type, text), confidence: PDF_TEXT_CONFIDENCE };
}

/**
 * One reading per uploaded document that has no structured payload and a
 * readable format (PNG/JPEG images, PDFs). Keyed by document id; other
 * documents are absent from the map and keep the "unreadable upload" rule.
 */
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
