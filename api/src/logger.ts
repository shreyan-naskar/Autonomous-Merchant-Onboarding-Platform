import { pino, type DestinationStream, type Logger } from 'pino';
import { mask, redactText } from '@app/shared';

/** Field names that must never be logged in clear text. */
const SENSITIVE_KEYS = ['pan', 'bank_account', 'bankAccount', 'account_number', 'accountNumber'];

/**
 * pino/fast-redact has no recursive wildcard, so enumerate paths up to a fixed
 * depth. Covers e.g. `pan`, `body.pan`, `body.documents[*].payload.pan`,
 * `callback.payload.result.bank_account`.
 */
function redactPaths(maxDepth = 5): string[] {
  const paths: string[] = [];
  for (const key of SENSITIVE_KEYS) {
    let prefix = '';
    for (let depth = 0; depth <= maxDepth; depth++) {
      paths.push(`${prefix}${key}`);
      prefix += '*.';
    }
  }
  return paths;
}

export function createLogger(opts: { level?: string; stream?: DestinationStream } = {}): Logger {
  return pino(
    {
      level: opts.level ?? 'info',
      redact: {
        paths: redactPaths(),
        censor: (value) => (typeof value === 'string' ? mask(value) : '[REDACTED]'),
      },
      // Last line of defence: scrub PAN/account-shaped text in messages and errors.
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === 'string' ? redactText(a) : a));
          method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
      serializers: {
        // Allowlist error fields: some errors carry raw input as extra props
        // (body-parser attaches the whole request `body`), so never spread them.
        err: (err: unknown) => {
          const s = pino.stdSerializers.err(err as Error);
          const extra = s as unknown as Record<string, unknown>;
          return {
            type: s.type,
            message: s.message ? redactText(s.message) : s.message,
            stack: s.stack ? redactText(s.stack) : s.stack,
            code: extra.code,
            status: extra.status,
          };
        },
      },
    },
    opts.stream,
  );
}

export type { Logger };
