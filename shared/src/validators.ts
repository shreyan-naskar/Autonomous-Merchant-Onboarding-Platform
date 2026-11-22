import { BANK_ACCOUNT_RE, GSTIN_RE, IFSC_RE, PAN_RE } from './intake.js';

/* Inputs are taken as-is: callers normalize case and whitespace first. */

type Maybe = string | null | undefined;

export const isValidPan = (v: Maybe): boolean => typeof v === 'string' && PAN_RE.test(v);
export const isValidGstin = (v: Maybe): boolean => typeof v === 'string' && GSTIN_RE.test(v);
export const isValidIfsc = (v: Maybe): boolean => typeof v === 'string' && IFSC_RE.test(v);
export const isValidBankAccount = (v: Maybe): boolean => typeof v === 'string' && BANK_ACCOUNT_RE.test(v);

/** The PAN embedded in a GSTIN: characters 3-12 (1-based). */
export const panFromGstin = (gstin: string): string => gstin.slice(2, 12);

/** True only when both values are well-formed and the GSTIN embeds this PAN. */
export function gstinMatchesPan(gstin: Maybe, pan: Maybe): boolean {
  return isValidGstin(gstin) && isValidPan(pan) && panFromGstin(gstin as string) === pan;
}


const NAME_SUFFIXES = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'p', 'co', 'inc', 'corp']);

/** Legal-form words (pvt, ltd, ...) are dropped, unless nothing else remains. */
export function normalizeName(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/\bm\/s\.?/g, ' ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const kept = tokens.filter((t) => !NAME_SUFFIXES.has(t));
  return (kept.length > 0 ? kept : tokens).join(' ');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** The larger of token overlap (reordered words) and edit-distance ratio (typos), in [0, 1]. */
export function nameSimilarity(a: Maybe, b: Maybe): number {
  if (!a || !b) return 0;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = shared / (ta.size + tb.size - shared);

  const ratio = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  return Math.max(jaccard, ratio);
}

export const namesMatch = (a: Maybe, b: Maybe, threshold: number): boolean => nameSimilarity(a, b) >= threshold;
