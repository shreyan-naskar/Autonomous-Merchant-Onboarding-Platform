import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { DOCUMENT_TYPES, type DocumentType } from '@app/shared';
import { blurScore, isBlurry } from './blur.js';
import type { OcrEngine } from './ocr.js';
import { parseDocumentText } from './text.js';

/*
 * Reads uploaded files (the slow, async part of extraction) into structured
 * payloads that extractFields() treats like JSON documents. Runs in the
 * extract job only, before its DB transaction.
 */

export interface DocumentReading {
  source: 'ocr';
  /** Parsed values, or null when nothing could be read (blurry, not an image, unreadable file). */
  payload: Record<string, string> | null;
  /** Confidence of the read (OCR mean confidence, 0-1). Caps every field's confidence. */
  confidence: number;
  blurScore?: number;
  blurry?: boolean;
  /** Why the file could not be read (no values, never file contents). */
  error?: 'file_unreadable' | 'not_an_image';
}

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
  const { text, confidence } = await deps.ocr.recognize(file);
  return { source: 'ocr', payload: parseDocumentText(type, text), confidence, blurScore: score, blurry: false };
}

/**
 * One reading per uploaded document that has no structured payload and a
 * readable format (PNG/JPEG images). Keyed by document id; other documents
 * are absent from the map and keep the "unreadable upload" rule.
 */
export async function readUploadedDocuments(
  docs: readonly ReadableDocument[],
  deps: ReadDeps,
): Promise<Map<number, DocumentReading>> {
  const read = deps.readFile ?? ((p: string) => readFile(p));
  const out = new Map<number, DocumentReading>();
  for (const d of docs) {
    if (d.payload != null || !d.path || !isDocumentType(d.type)) continue;
    if (!IMAGE_EXTENSIONS.has(extname(d.path).toLowerCase())) continue;
    let file: Buffer;
    try {
      file = await read(d.path);
    } catch {
      out.set(d.id, { source: 'ocr', payload: null, confidence: 0, error: 'file_unreadable' });
      continue;
    }
    out.set(d.id, await readImage(d.type, file, deps));
  }
  return out;
}
