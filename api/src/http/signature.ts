import { createHmac, timingSafeEqual } from 'node:crypto';

/** Hex HMAC-SHA256 of the raw request body (the X-Signature header value). */
export function signBody(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Constant-time check of an X-Signature header against the raw body.
 * Accepts an optional `sha256=` prefix. Anything malformed is simply invalid.
 */
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (typeof header !== 'string') return false;
  const hex = header.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(hex, 'hex'));
}
