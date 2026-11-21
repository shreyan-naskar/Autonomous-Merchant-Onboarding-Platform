import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allReviewReasons, VERIFICATION_KINDS, VERIFICATION_STATUSES, type VerificationKind, type VerificationStatus } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { failureReason } from './verification/evaluate.js';

/*
 * The web app turns review task reasons into plain language using the list
 * in shared/src/labels.ts (allReviewReasons). This proves the API can only
 * create reasons on that list; web/src/lib/labels.test.ts proves every one
 * has a label.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));
const known = new Set(allReviewReasons());

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('review task reasons created by the API are all known to the UI', () => {
  it('every verification-result reason evaluate() can produce (all state combinations)', () => {
    const states: (VerificationStatus | undefined)[] = [...VERIFICATION_STATUSES, undefined];
    let produced = 0;
    for (const pan of states)
      for (const gst of states)
        for (const bank of states)
          for (const risk of states) {
            const s: Partial<Record<VerificationKind, VerificationStatus>> = { PAN: pan, GST: gst, BANK: bank, RISK: risk };
            const reason = failureReason(s as Record<VerificationKind, VerificationStatus>);
            if (reason === null) continue;
            produced++;
            expect(known.has(reason), reason).toBe(true);
          }
    expect(produced).toBeGreaterThan(100);
  });

  it('timeout reasons (`<KIND>_TIMEOUT` in verification/timeout.ts)', () => {
    expect(readFileSync(join(SRC, 'verification', 'timeout.ts'), 'utf8')).toContain('`${row.kind}_TIMEOUT`');
    for (const k of VERIFICATION_KINDS) expect(known.has(`${k}_TIMEOUT`)).toBe(true);
  });

  it('every literal review task reason in the API source', () => {
    const literals = new Map<string, string>();
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      const text = readFileSync(file, 'utf8');
      // extraction/decide.ts: only its IN_REVIEW outcomes become review tasks.
      const re = rel === join('extraction', 'decide.ts') ? /to: 'IN_REVIEW', reason: '([A-Z_]+)'/g : /reason: '([A-Z][A-Z_]+)'/g;
      for (const m of text.matchAll(re)) literals.set(m[1]!, rel);
    }
    expect(literals.size).toBeGreaterThanOrEqual(8);
    for (const [code, file] of literals) expect(known.has(code), `${code} (${file})`).toBe(true);
  });
});
