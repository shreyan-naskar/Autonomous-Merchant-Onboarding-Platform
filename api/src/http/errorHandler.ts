import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
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
    } else if (err instanceof multer.MulterError) {
      // Upload limits / unexpected file parts. Messages are multer's fixed strings.
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      body = { error: { code: 'UPLOAD_REJECTED', message: err.message, details: { reason: err.code, field: err.field } } };
    } else if (isBodyParserError(err) && err.status >= 400 && err.status < 500) {
      status = err.status;
      const message = err.type === 'entity.parse.failed' ? 'Malformed JSON body' : 'Invalid request body';
      body = { error: { code: 'BAD_REQUEST', message } };
    } else {
      body = { error: { code: 'INTERNAL', message: 'Internal server error' } };
    }

    const log = status >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
    // The path can contain a PAN or account number (typed into a URL): redact it.
    log({ err, method: req.method, path: redactText(req.originalUrl.split('?')[0] ?? ''), status }, 'request failed');

    res.status(status).json(body);
  };
}

/**
 * Unknown routes: JSON 404 (never Express's HTML page). The path is echoed
 * for debugging but redacted, since a PAN or account number can end up in a
 * URL.
 */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: redactText(`No route ${req.method} ${req.path}`) } });
};
