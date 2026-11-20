/**
 * Mask a sensitive value, keeping only the last 4 characters visible.
 * Values of 4 characters or fewer are fully masked so nothing leaks.
 */
export function mask(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (s.length <= 4) return '*'.repeat(s.length);
  return '*'.repeat(s.length - 4) + s.slice(-4);
}

// PAN shape (also matches the PAN inside a GSTIN) and bank-account-like digit runs.
const PAN_LIKE = /[A-Z]{5}[0-9]{4}[A-Z]/g;
const ACCOUNT_LIKE = /\b\d{9,18}\b/g;

/**
 * Best-effort scrubbing of free text (error messages, notes) that might contain
 * a raw PAN or bank account number. Used as a last line of defence in logs and
 * error responses; structured fields should use mask() directly.
 */
export function redactText(text: string): string {
  return text
    .replace(PAN_LIKE, (m) => mask(m) as string)
    .replace(ACCOUNT_LIKE, (m) => mask(m) as string);
}

/**
 * Keys whose values are sensitive wherever they appear (form fields, document
 * payloads, provider results). A GSTIN embeds the PAN, so GST keys count too.
 * Shared by the API response mapper and the log redactor.
 */
export const SENSITIVE_KEYS = [
  'pan',
  'gst',
  'gstin',
  'bank_account',
  'bankAccount',
  'account_number',
  'accountNumber',
] as const;

const SENSITIVE = new Set<string>(SENSITIVE_KEYS);
const ID_KEY = /(^id$|_id$|Id$)/;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.has(key);
}

/**
 * Deep-copy free-form JSON (document payloads, audit details) for display:
 * values under SENSITIVE_KEYS are mask()ed, other strings go through
 * redactText(), except id-like keys (a UUID's last group can be all digits).
 */
export function maskDeep(value: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE.has(key)) {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'string' || typeof value === 'number') return mask(String(value));
    return '[REDACTED]';
  }
  if (typeof value === 'string') return key !== undefined && ID_KEY.test(key) ? value : redactText(value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, k);
    return out;
  }
  return value;
}
