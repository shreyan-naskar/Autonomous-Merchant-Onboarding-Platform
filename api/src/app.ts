import express, { type Express } from 'express';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Logger } from './logger.js';
import { createSimulatedMerchantService, type SimulatedMerchantService } from './merchant/service.js';
import { errorHandler, notFoundHandler } from './http/errorHandler.js';
import { adminRouter } from './http/routes/admin.js';
import { applicationsRouter } from './http/routes/applications.js';
import { reviewTasksRouter } from './http/routes/reviewTasks.js';
import { webhooksRouter } from './http/routes/webhooks.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  db: Db;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
  /**
   * Simulated merchant ID service whose failure flag POST /admin/merchant-service
   * toggles. Pass the same instance to createJobHandlers so the worker sees it.
   */
  merchantService?: SimulatedMerchantService;
  /** Hook for tests / later phases to mount extra routers before the 404 handler. */
  mount?: (app: Express) => void;
}

export function createApp(deps: AppDeps): Express {
  const { logger, db, config } = deps;
  const now = deps.now ?? Date.now;
  const merchantService = deps.merchantService ?? createSimulatedMerchantService(db);
  const app = express();

  // Request log: method, path, status, duration. Never the body.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.debug({ method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms }, 'request');
    });
    next();
  });

  // Before the JSON parser: the webhook signature is over the raw body.
  app.use('/webhooks', webhooksRouter({ db, logger, hmacSecret: config.hmacSecret, now }));

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'api' });
  });

  app.use('/applications', applicationsRouter({ db, logger, config, uploadDir: config.uploadDir, now }));

  app.use('/review-tasks', reviewTasksRouter({ db }));
  app.use('/admin', adminRouter({ merchantService, logger }));

  deps.mount?.(app);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
