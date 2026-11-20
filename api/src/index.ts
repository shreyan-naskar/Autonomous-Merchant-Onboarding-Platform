import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { createJobHandlers } from './jobs/handlers.js';
import { startWorker } from './jobs/worker.js';
import { createLogger } from './logger.js';
import { createHttpProviderClient } from './providers/client.js';

// Load the repo-root .env for local dev (tests never import this file).
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel });
const db = openDb(config.dbPath);
const app = createApp({ config, logger, db });

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, demoMode: config.demoMode }, `API running at http://localhost:${config.port}`);
});

const worker = startWorker({
  db,
  config,
  logger,
  handlers: createJobHandlers({ providers: createHttpProviderClient({ baseUrl: config.mockProviderUrl }) }),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close();
    void worker.stop().finally(() => {
      db.$client.close();
      process.exit(0);
    });
  });
}
