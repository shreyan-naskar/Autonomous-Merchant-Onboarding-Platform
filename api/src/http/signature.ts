import { createHmac, timingSafeEqual } from 'node:crypto';

export function signBody(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** timingSafeEqual, so the comparison leaks nothing about how much of a forged signature matched. */
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (typeof header !== 'string') return false;
  const hex = header.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(hex, 'hex'));
}
