import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { createTesseractOcr } from './extraction/ocr.js';
import { createJobHandlers } from './jobs/handlers.js';
import { startWorker } from './jobs/worker.js';
import { createLogger } from './logger.js';
import { createSimulatedMerchantService } from './merchant/service.js';
import { withOcrModelCheck } from './ocr-model.js';
import { createHttpProviderClient } from './providers/client.js';

// Load the repo-root .env for local dev (tests never import this file).
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel });
const db = openDb(config.dbPath);
// One instance shared by the API (failure flag) and the worker (create_merchant).
const merchantService = createSimulatedMerchantService(db);
const app = createApp({ config, logger, db, merchantService });

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, demoMode: config.demoMode }, `API running at http://localhost:${config.port}`);
});

// OCR for uploaded images; the model loads on the first image, in the worker.
// Without a cached model and no way to download it, jobs fail with "OCR model unavailable" (see ocr-model.ts).
const ocr = withOcrModelCheck(createTesseractOcr({ cacheDir: config.ocrCacheDir }), { cacheDir: config.ocrCacheDir });

const worker = startWorker({
  db,
  config,
  logger,
  handlers: createJobHandlers({
    providers: createHttpProviderClient({ baseUrl: config.mockProviderUrl }),
    merchantService,
    ocr,
  }),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close();
    void worker
      .stop()
      .then(() => ocr.terminate())
      .finally(() => {
        db.$client.close();
        process.exit(0);
      });
  });
}
