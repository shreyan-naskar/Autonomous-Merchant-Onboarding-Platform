import { ProviderCallbackSchema, SIGNATURE_HEADER, redactText } from '@app/shared';
import express, { Router } from 'express';
import type { Db } from '../../db/client.js';
import type { Logger } from '../../logger.js';
import { receiveCallback } from '../../verification/callback.js';
import { verifySignature } from '../signature.js';

export interface WebhookDeps {
  db: Db;
  logger: Logger;
  hmacSecret: string;
  now: () => number;
}

/**
 * Provider callbacks. Must be mounted before the app-wide JSON parser: the
 * HMAC is over the exact bytes received, so this route reads the raw body.
 */
export function webhooksRouter(deps: WebhookDeps): Router {
  const router = Router();

  router.post('/provider', express.raw({ type: () => true, limit: '64kb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(deps.hmacSecret, raw, req.get(SIGNATURE_HEADER))) {
      deps.logger.warn({ path: redactText(req.originalUrl), bytes: raw.length }, 'webhook rejected: bad signature');
      res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid or missing signature' } });
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } });
      return;
    }
    const parsed = ProviderCallbackSchema.safeParse(json);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Invalid callback',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
        },
      });
      return;
    }

    const result = receiveCallback({ db: deps.db, logger: deps.logger, now: deps.now() }, parsed.data);
    res.status(200).json({
      status: result.duplicate ? 'duplicate' : 'accepted',
      event_id: parsed.data.event_id,
      ...(result.duplicate ? {} : { outcome: result.outcome }),
    });
  });

  return router;
}
