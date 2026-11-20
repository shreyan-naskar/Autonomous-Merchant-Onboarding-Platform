import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Worker } from 'tesseract.js';

/** OCR result: full text plus the engine's mean confidence, scaled to 0-1. */
export interface OcrResult {
  text: string;
  confidence: number;
}

/**
 * OCR behind an interface so the extract job is testable without Tesseract
 * (tests pass a fake; one test runs the real engine on the sample image).
 * Only the extract job calls this, never a request handler.
 */
export interface OcrEngine {
  recognize(image: Buffer): Promise<OcrResult>;
  terminate(): Promise<void>;
}

/**
 * tesseract.js engine. The worker (and the English model, downloaded once
 * into `cacheDir`) is created on first use, so startup and tests that never
 * OCR pay nothing. The worker runs recognitions one at a time.
 */
export function createTesseractOcr({ cacheDir }: { cacheDir: string }): OcrEngine {
  let worker: Promise<Worker> | undefined;
  const getWorker = () => {
    if (!worker) {
      worker = (async () => {
        const dir = resolve(cacheDir);
        // tesseract.js silently skips caching when the directory is missing.
        mkdirSync(dir, { recursive: true });
        const { createWorker } = await import('tesseract.js');
        return createWorker('eng', 1, { cachePath: dir });
      })();
      // A failed start (e.g. model download failed) is retried on the next call.
      worker.catch(() => {
        worker = undefined;
      });
    }
    return worker;
  };
  return {
    async recognize(image) {
      const w = await getWorker();
      const { data } = await w.recognize(image);
      return { text: data.text, confidence: Math.max(0, Math.min(1, data.confidence / 100)) };
    },
    async terminate() {
      if (!worker) return;
      const w = await worker.catch(() => undefined);
      worker = undefined;
      await w?.terminate();
    },
  };
}
