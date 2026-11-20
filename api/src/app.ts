import express, { type Express } from 'express';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Logger } from './logger.js';
import { errorHandler, notFoundHandler } from './http/errorHandler.js';
import { applicationsRouter } from './http/routes/applications.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  db: Db;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
  /** Hook for tests / later phases to mount extra routers before the 404 handler. */
  mount?: (app: Express) => void;
}

export function createApp(deps: AppDeps): Express {
  const { logger, db, config } = deps;
  const now = deps.now ?? Date.now;
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // Request log: method, path, status, duration. Never the body.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.debug({ method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms }, 'request');
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'api' });
  });

  app.use('/applications', applicationsRouter({ db, logger, uploadDir: config.uploadDir, now }));

  deps.mount?.(app);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
