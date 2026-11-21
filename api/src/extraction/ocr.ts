import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Worker } from 'tesseract.js';

interface OcrWord {
  text: string;
  confidence: number;
}

/** Per-word confidences matter: on a real card the page mean is dragged down by Hindi text, the hologram and the photo. */
export interface OcrResult {
  text: string;
  confidence: number;
  words?: OcrWord[];
}

/** An interface so tests run without Tesseract. Only the extract job calls it, never a request handler. */
export interface OcrEngine {
  recognize(image: Buffer): Promise<OcrResult>;
  terminate(): Promise<void>;
}

/** Created on first use (the English model is downloaded once into cacheDir), so nothing pays for OCR until it is needed. */
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
      const { data } = await w.recognize(image, {}, { text: true, blocks: true });
      const scale = (c: number) => Math.max(0, Math.min(1, c / 100));
      const words = (data.blocks ?? []).flatMap((b) =>
        b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words.map((wd) => ({ text: wd.text, confidence: scale(wd.confidence) })))),
      );
      return { text: data.text, confidence: scale(data.confidence), words };
    },
    async terminate() {
      if (!worker) return;
      const w = await worker.catch(() => undefined);
      worker = undefined;
      await w?.terminate();
    },
  };
}
