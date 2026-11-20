import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import { redactText } from '@app/shared';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

/** Body-parser errors carry `type`/`status`; their message can quote the raw body. */
function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return typeof err === 'object' && err !== null && 'type' in err && 'status' in err;
}

/**
 * Central error handler. Express 5 forwards rejected promises from async
 * handlers here, so routes just throw. Responses never include raw input
 * values: Zod issues are reduced to path/code/message, unknown errors become
 * a generic 500, and any message we do return is passed through redactText().
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let status = 500;
    let body: ErrorBody;

    if (err instanceof AppError) {
      status = err.status;
      body = {
        error: { code: err.code, message: redactText(err.message), details: err.details },
      };
    } else if (err instanceof z.ZodError) {
      status = 400;
      body = {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: err.issues.map((i) => ({
            path: i.path.join('.'),
            code: i.code,
            message: redactText(i.message),
          })),
        },
      };
    } else if (isBodyParserError(err) && err.status >= 400 && err.status < 500) {
      status = err.status;
      const message = err.type === 'entity.parse.failed' ? 'Malformed JSON body' : 'Invalid request body';
      body = { error: { code: 'BAD_REQUEST', message } };
    } else {
      body = { error: { code: 'INTERNAL', message: 'Internal server error' } };
    }

    const log = status >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
    log({ err, method: req.method, path: req.path, status }, 'request failed');

    res.status(status).json(body);
  };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.path}` } });
};
