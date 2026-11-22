import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { DOCUMENT_TYPES, type DocumentType } from '@app/shared';
import { blurScore, isBlurry } from './blur.js';
import { DOCUMENT_FIELDS } from './extract.js';
import { analyseLayout, isBlank, normalizeImage, OCR_PASSES, straighten, trimMargins, turn } from './image.js';
import type { OcrEngine, OcrResult } from './ocr.js';
import { isPasswordError, pdfPageImages, pdfText, type PdfText } from './pdf.js';
import { looksLike, parseDocumentText, patternValues } from './text.js';

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
  error?: ReadError;
  /** The text reads as another kind of document, and this one's identifier was not found in it. */
  looksLike?: DocumentType;
}

export type ReadError = 'file_unreadable' | 'not_an_image' | 'not_a_pdf' | 'no_text_layer' | 'blank' | 'password_protected' | 'no_text';

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
  /** Every pass's text. */
  text: string;
  /** The first pass's page confidence. */
  confidence: number;
  fieldConfidence: Record<string, number>;
  /** No rows of text in the image (a photo, noise): OCR was not run, or found nothing on an unclear layout. */
  noText: boolean;
}

/** At or above this in either direction the image has clear text lines (calibrated in read.test.ts: text scores above 1.3, noise and photos below 0.6). */
export const MIN_TEXT_LINES = 0.9;
/**
 * Below this the image is clearly not text, and OCR is not run. Between this
 * and MIN_TEXT_LINES the layout alone cannot tell (a card whose security
 * pattern or QR code crowds every row scores here), so OCR decides.
 */
export const NO_TEXT_LINES = 0.6;
/** Words a pass must read clearly, when it finds no field, for an uncertain layout to count as text. */
const MIN_GOOD_WORDS = 3;
/** Smaller tilts don't bother Tesseract, and rotating costs a little sharpness. */
const MIN_SKEW = 0.75;
/** Tried in this order when the upright image yields none of the document's fields. */
const TURNS = [180, 90, 270] as const;

/** Fields compared character for character with the form, so a misread can't pass unnoticed. */
const ID_KEYS = new Set(['pan', 'gstin', 'ifsc', 'account_number']);
/** Tesseract scores codes and names low because they aren't dictionary words; this many differently prepared passes reading the same value is the real evidence. */
const AGREEING_PASSES = 3;
const AGREED_CONFIDENCE = 0.9;
/** Below the default 0.8 review threshold: a value with a corrected look-alike character is a guess a person confirms. */
export const GUESS_CONFIDENCE = 0.7;
/** An ID read below this keeps the remaining passes running, to look for agreement. */
const CONFIDENT = 0.8;

/** Whether the value appears in the text as is (spaces and O/0 aside), rather than only after correcting a look-alike. */
const spelledOut = (value: string, text: string) => norm(text).includes(norm(value));

/** Caps every ID that is a guess; returns field confidences for those keys. */
function capGuesses(payload: Record<string, string>, fieldConfidence: Record<string, number>, text: string, fallback: number) {
  const out = { ...fieldConfidence };
  for (const [k, v] of Object.entries(payload)) {
    if (ID_KEYS.has(k) && !spelledOut(v, text)) out[k] = Math.min(out[k] ?? fallback, GUESS_CONFIDENCE);
  }
  return out;
}

/** Real words read with confidence: how much sense a pass made of the image. */
const goodWords = (r: OcrResult) => (r.words ?? []).filter((w) => w.confidence >= 0.75 && /^[A-Za-z]{3,}$/.test(w.text)).length;

/**
 * OCR passes in order (image.ts) until every expected field is found. A field
 * keeps the value and word confidence of the first pass that found it, and
 * fields already in `have` (e.g. from a PDF text layer) are not overwritten.
 * OCR errors (e.g. model download failed) propagate: the worker retries the job.
 */
async function ocrFields(type: DocumentType, png: Buffer, ocr: OcrEngine, have: Record<string, string> = {}): Promise<OcrRead> {
  const want = expectedKeys(type);
  const out: OcrRead = { payload: {}, text: '', confidence: 0, fieldConfidence: {}, noText: false };
  const layout = await analyseLayout(png);
  const rows = Math.max(layout.lines, layout.columns);
  // Nothing laid out in rows: OCR of noise or a photo takes long and finds nothing.
  if (rows < NO_TEXT_LINES) return { ...out, noText: true };
  // Unclear rows: the measured tilt is not trustworthy either, so the image is read as it is.
  const uncertain = rows < MIN_TEXT_LINES;
  let image = !uncertain && Math.abs(layout.skew) >= MIN_SKEW ? await straighten(png, layout.skew) : png;

  const [firstPass, ...otherPasses] = OCR_PASSES;
  const run = async (img: Buffer, pass: typeof firstPass) => ocr.recognize(await pass!.prepare(img), pass!.mode);
  const finds = (r: OcrResult) => Object.keys(parseDocumentText(type, r.text)).some((k) => want.includes(k));
  const agreeing: Record<string, number> = {};
  // A field keeps the value of the first pass that found it; a later pass reading the same value adds agreement.
  const take = (r: OcrResult) => {
    out.text += `${r.text}\n`;
    for (const [k, v] of Object.entries(parseDocumentText(type, r.text))) {
      if (k in have) continue;
      const c = r.words?.length ? valueConfidence(v, r.words, r.confidence) : r.confidence;
      if (!(k in out.payload)) {
        out.payload[k] = v;
        out.fieldConfidence[k] = c;
        agreeing[k] = 1;
      } else if (norm(out.payload[k]!) === norm(v)) {
        agreeing[k]!++;
        out.fieldConfidence[k] = Math.max(out.fieldConfidence[k]!, c, agreeing[k]! >= AGREEING_PASSES ? AGREED_CONFIDENCE : 0);
      }
    }
  };
  const settled = () =>
    want.every((k) => k in have || (k in out.payload && (!ID_KEYS.has(k) || out.fieldConfidence[k]! >= CONFIDENT)));

  let first = await run(image, firstPass);
  // Upside down or on its side: try the other orientations, keeping one that reads clearly better.
  if (!finds(first)) {
    for (const degrees of TURNS) {
      const turned = await turn(image, degrees);
      const r = await run(turned, firstPass);
      if (finds(r) || goodWords(r) > Math.max(2, goodWords(first) * 2)) {
        [image, first] = [turned, r];
        break;
      }
    }
  }
  // An unclear layout that OCR cannot make sense of in any orientation is not a document.
  if (uncertain && !finds(first) && goodWords(first) < MIN_GOOD_WORDS) return { ...out, noText: true };
  out.confidence = first.confidence;
  take(first);
  for (const pass of otherPasses) {
    if (settled()) break;
    take(await run(image, pass));
  }
  out.fieldConfidence = capGuesses(out.payload, out.fieldConfidence, out.text, out.confidence);
  return out;
}

async function readImage(type: DocumentType, file: Buffer, deps: ReadDeps): Promise<DocumentReading> {
  let png: Buffer;
  let score: number;
  try {
    png = await normalizeImage(file);
    if (await isBlank(png)) return { source: 'ocr', payload: null, confidence: 0, error: 'blank' };
    score = await blurScore(png);
  } catch {
    // Corrupt or mislabelled: deterministic, so not worth a retry.
    return { source: 'ocr', payload: null, confidence: 0, error: 'not_an_image' };
  }
  if (isBlurry(score, deps.blurThreshold)) {
    return { source: 'ocr', payload: null, confidence: 0, blurScore: score, blurry: true };
  }
  const read = await ocrFields(type, png, deps.ocr);
  if (read.noText) return { source: 'ocr', payload: null, confidence: 0, blurScore: score, blurry: false, error: 'no_text' };
  const { payload, confidence, fieldConfidence } = read;
  return { source: 'ocr', payload, confidence, ...withFieldConfidence(fieldConfidence), ...wrongType(type, payload, read.text), blurScore: score, blurry: false };
}

/** Which field identifies each kind of document: without it, the upload may simply be the wrong document. */
const IDENTIFIER: Record<DocumentType, string> = { PAN_CARD: 'pan', GST_CERT: 'gstin', BANK_PROOF: 'ifsc' };

function wrongType(type: DocumentType, payload: Record<string, string>, text: string): { looksLike?: DocumentType } {
  if (IDENTIFIER[type] in payload) return {};
  const other = looksLike(type, text);
  return other ? { looksLike: other } : {};
}

const withFieldConfidence = (fc: Record<string, number>) => (Object.keys(fc).length > 0 ? { fieldConfidence: fc } : {});

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0');

/** How many OCR words one value may be split across ("27AAFCS4321", "M1", "Z5"). */
const MAX_WORD_SPLIT = 3;
/** Noise OCR may run into the end of a value ("AAFCS4321Mm"). */
const MAX_TRAILING_NOISE = 2;

/** The best confidence of the word, or run of consecutive words, that spells the token. */
function tokenConfidence(token: string, words: readonly { text: string; confidence: number }[]): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    let min = 1;
    for (let j = i; j < Math.min(words.length, i + MAX_WORD_SPLIT); j++) {
      joined += norm(words[j]!.text);
      min = Math.min(min, words[j]!.confidence);
      const spells = j === i ? joined.startsWith(token) && joined.length - token.length <= MAX_TRAILING_NOISE : joined === token;
      if (spells) best = Math.max(best ?? 0, min);
      if (joined.length >= token.length) break;
    }
  }
  return best;
}

/** The weakest of the value's words; the page confidence when a word can't be matched (e.g. normalized after OCR). */
export function valueConfidence(value: string, words: readonly { text: string; confidence: number }[], fallback: number): number {
  let min = 1;
  for (const token of value.split(/\s+/).map(norm).filter(Boolean)) {
    const c = tokenConfidence(token, words);
    if (c === undefined) return fallback;
    min = Math.min(min, c);
  }
  return Math.round(min * 100) / 100;
}

/** Below the review threshold: a field the text layer holds twice, differently, that the rendered page could not settle. */
export const AMBIGUOUS_CONFIDENCE = 0.5;

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length]!;
}

interface PageRead {
  payload: Record<string, string>;
  fieldConfidence: Record<string, number>;
  /** All OCR text, normalized. */
  text: string;
  /** All OCR text as read, for telling which kind of document it is. */
  raw: string;
  confidence?: number;
  blurScore?: number;
  /** Pages rendered, pages with anything on them, and pages with no text lines. */
  pages: number;
  scanned: number;
  noText: number;
}

/** OCR of the rendered pages: what a reader actually sees. Blank pages are skipped and blurry ones not OCR'd. */
async function readPages(type: DocumentType, file: Buffer, deps: ReadDeps): Promise<PageRead> {
  const out: PageRead = { payload: {}, fieldConfidence: {}, text: '', raw: '', pages: 0, scanned: 0, noText: 0 };
  let pages: Buffer[];
  try {
    pages = await pdfPageImages(file);
  } catch {
    return out;
  }
  out.pages = pages.length;
  const want = expectedKeys(type);
  for (const page of pages) {
    const png = await trimMargins(page);
    const score = await blurScore(png);
    // A blank page has no edges at all: nothing to read, and not a blurry scan.
    if (score === 0) continue;
    out.scanned++;
    if (isBlurry(score, deps.blurThreshold)) {
      out.blurScore = Math.max(out.blurScore ?? 0, score);
      continue;
    }
    const read = await ocrFields(type, png, deps.ocr, out.payload);
    if (read.noText) {
      out.noText++;
      continue;
    }
    out.confidence ??= read.confidence;
    out.text += norm(read.text);
    out.raw += `${read.text}\n`;
    Object.assign(out.payload, read.payload);
    Object.assign(out.fieldConfidence, read.fieldConfidence);
    if (want.every((k) => k in out.payload)) break;
  }
  return out;
}

/**
 * The text layer is exact, so it is used alone when it has every field once.
 * Otherwise the pages are rendered and OCR'd: for a scan to find the fields at
 * all, and for an edited PDF (text drawn over text, or two values for one
 * field) to tell the visible value from one hidden under a white box.
 * Per field: a text-layer value OCR also sees wins at PDF_TEXT_CONFIDENCE; a
 * near miss is OCR noise unless the PDF looks edited; otherwise OCR's value.
 */
async function readPdf(type: DocumentType, file: Buffer, deps: ReadDeps): Promise<DocumentReading> {
  let layer: PdfText;
  try {
    layer = await pdfText(file);
  } catch (err) {
    return { source: 'pdf', payload: null, confidence: 0, error: isPasswordError(err) ? 'password_protected' : 'not_a_pdf' };
  }
  const hasText = layer.text.trim() !== '';
  const fromText = hasText ? parseDocumentText(type, layer.text) : {};
  const candidates = hasText ? patternValues(type, layer.text) : {};
  const ambiguous = new Set(Object.keys(candidates).filter((k) => candidates[k]!.length > 1));
  const want = expectedKeys(type);
  if (want.every((k) => k in fromText) && ambiguous.size === 0 && !layer.overlapping) {
    return { source: 'pdf', payload: fromText, confidence: PDF_TEXT_CONFIDENCE, ...withFieldConfidence(capGuesses(fromText, {}, layer.text, PDF_TEXT_CONFIDENCE)) };
  }

  const seen = await readPages(type, file, deps);
  if (!hasText && seen.confidence === undefined) {
    if (seen.blurScore !== undefined && seen.scanned > 0) {
      return { source: 'pdf', payload: null, confidence: 0, blurScore: seen.blurScore, blurry: true };
    }
    const error = seen.pages > 0 && seen.scanned === 0 ? 'blank' : seen.noText > 0 ? 'no_text' : 'no_text_layer';
    return { source: 'pdf', payload: null, confidence: 0, error };
  }

  const payload: Record<string, string> = {};
  const fieldConfidence: Record<string, number> = {};
  const set = (k: string, v: string, c: number) => {
    payload[k] = v;
    fieldConfidence[k] = c;
  };
  for (const k of want) {
    const textValues = ambiguous.has(k) ? candidates[k]! : k in fromText ? [fromText[k]!] : [];
    const ocrValue = seen.payload[k];
    const edited = layer.overlapping || ambiguous.has(k);
    const visible = seen.text === '' ? [] : textValues.filter((t) => seen.text.includes(norm(t)));
    const confirmed = textValues.find((t) => ocrValue !== undefined && norm(t) === norm(ocrValue)) ?? (visible.length === 1 ? visible[0] : undefined);
    if (confirmed !== undefined) set(k, confirmed, PDF_TEXT_CONFIDENCE);
    else if (ocrValue !== undefined) {
      const near = !edited && textValues.length === 1 && editDistance(norm(textValues[0]!), norm(ocrValue)) <= 2;
      if (near) set(k, textValues[0]!, PDF_TEXT_CONFIDENCE);
      else set(k, ocrValue, seen.fieldConfidence[k]!);
    } else if (textValues.length === 1) set(k, textValues[0]!, PDF_TEXT_CONFIDENCE);
    else if (textValues.length > 1) set(k, textValues[0]!, AMBIGUOUS_CONFIDENCE);
  }
  const usedOcr = seen.confidence !== undefined || ambiguous.size > 0;
  const confidence = hasText ? PDF_TEXT_CONFIDENCE : seen.confidence!;
  const allText = `${layer.text}\n${seen.raw}`;
  const guessed = capGuesses(payload, usedOcr ? fieldConfidence : {}, allText, confidence);
  return { source: 'pdf', payload, confidence, ...withFieldConfidence(guessed), ...wrongType(type, payload, allText) };
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
