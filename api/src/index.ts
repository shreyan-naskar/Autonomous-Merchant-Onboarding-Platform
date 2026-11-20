import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

// Load the repo-root .env for local dev (tests never import this file).
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel });
const app = createApp({ config, logger });

app.listen(config.port, () => {
  logger.info({ port: config.port, demoMode: config.demoMode }, `API running at http://localhost:${config.port}`);
});
