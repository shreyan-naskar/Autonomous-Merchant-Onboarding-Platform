import express, { type Express } from 'express';

/**
 * Mock provider app factory. Integration tests start this in-process on a
 * random port; index.ts listens on 4000 for local dev. Provider endpoints
 * (POST /pan/verify, /gst/verify, /bank/verify, /risk/score) arrive in Phase 4.
 */
export function createMockApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'mock-providers' });
  });

  return app;
}
