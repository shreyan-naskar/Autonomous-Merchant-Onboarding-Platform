/*
 * Downloads the Tesseract English model into OCR_CACHE_DIR (default
 * api/.ocr-cache), so uploads work offline and the first one is not slow.
 *   npm run ocr:warm
 * Reads the same root .env and OCR_CACHE_DIR as the API; a relative path is
 * relative to api/, where the API runs.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../api/src/config.js';
import { createTesseractOcr } from '../api/src/extraction/ocr.js';
import { OCR_MODEL_FILE, OCR_MODEL_UNAVAILABLE, ocrModelCached, withOcrModelCheck } from '../api/src/ocr-model.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = join(root, '.env');
if (existsSync(env)) process.loadEnvFile(env);

const cacheDir = resolve(root, 'api', loadConfig(process.env).ocrCacheDir);
const model = join(cacheDir, OCR_MODEL_FILE);
const size = () => `${(statSync(model).size / 1e6).toFixed(1)} MB`;

const fail = (detail?: unknown) => {
  console.error(OCR_MODEL_UNAVAILABLE);
  const text = detail instanceof Error ? detail.message : detail === undefined ? '' : String(detail);
  if (text && text !== OCR_MODEL_UNAVAILABLE) console.error(`(${text})`);
  process.exit(1);
};
// tesseract.js reports a download that fails part-way as an uncaught error from its worker.
process.on('uncaughtException', fail);

if (ocrModelCached(cacheDir)) {
  console.log(`OCR model already cached: ${model} (${size()})`);
  process.exit(0);
}

console.log(`Downloading the OCR model (about 5 MB) into ${cacheDir} ...`);
const ocr = withOcrModelCheck(createTesseractOcr({ cacheDir }), { cacheDir });
const timer = setTimeout(() => fail('no answer after 3 minutes'), 180_000);
try {
  // Reading one sample image loads the model, exactly as the first upload would.
  const { text } = await ocr.recognize(readFileSync(join(root, 'sample-data', 'pan-sharp.png')));
  if (!ocrModelCached(cacheDir) || !text.trim()) fail('the model did not load');
  console.log(`OCR model ready: ${model} (${size()})`);
} catch (err) {
  fail(err);
} finally {
  clearTimeout(timer);
  await ocr.terminate();
}
