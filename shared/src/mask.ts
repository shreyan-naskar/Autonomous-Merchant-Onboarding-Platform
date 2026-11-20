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
