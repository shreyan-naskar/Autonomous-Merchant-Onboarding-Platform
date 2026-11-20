import express, { type Express } from 'express';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { errorHandler, notFoundHandler } from './http/errorHandler.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  /** Hook for tests / later phases to mount extra routers before the 404 handler. */
  mount?: (app: Express) => void;
}

export function createApp(deps: AppDeps): Express {
  const { logger } = deps;
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // Request log: method, path, status, duration. Never the body.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.debug({ method: req.method, path: req.path, status: res.statusCode, ms }, 'request');
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'api' });
  });

  deps.mount?.(app);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
