import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OcrEngine } from './extraction/ocr.js';

/*
 * The OCR model (Tesseract English) is downloaded by tesseract.js on first
 * use into OCR_CACHE_DIR. Offline, tesseract.js does not reject: its worker
 * throws an uncaught "fetch failed", which ends the API process, and the
 * recognize call never settles. So while the model is not cached, check the
 * download first and fail with a plain error instead; the extract job then
 * retries and dead-letters with that reason. Once the model is cached this
 * wrapper only passes calls through. `npm run ocr:warm` caches it ahead of time.
 */

export const OCR_MODEL_FILE = 'eng.traineddata';
/** Where tesseract.js 7 downloads the model from (LSTM only, as createTesseractOcr starts it). */
export const OCR_MODEL_URL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';

export const OCR_MODEL_UNAVAILABLE =
  'OCR model unavailable: the English text-recognition model is not on this machine and could not be downloaded. ' +
  'Run npm run ocr:warm with internet access, then requeue.';

export class OcrModelUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(OCR_MODEL_UNAVAILABLE, options);
    this.name = 'OcrModelUnavailableError';
  }
}

export const ocrModelCached = (cacheDir: string) => existsSync(join(resolve(cacheDir), OCR_MODEL_FILE));

/** True when the model's download URL answers. */
export async function modelDownloadReachable(timeoutMs = 5_000): Promise<boolean> {
  try {
    const res = await fetch(OCR_MODEL_URL, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export function withOcrModelCheck(
  engine: OcrEngine,
  { cacheDir, reachable = modelDownloadReachable }: { cacheDir: string; reachable?: () => Promise<boolean> },
): OcrEngine {
  return {
    async recognize(image, mode) {
      if (!ocrModelCached(cacheDir) && !(await reachable())) throw new OcrModelUnavailableError();
      try {
        return await engine.recognize(image, mode);
      } catch (err) {
        if (!ocrModelCached(cacheDir)) throw new OcrModelUnavailableError({ cause: err });
        throw err;
      }
    },
    terminate: () => engine.terminate(),
  };
}
