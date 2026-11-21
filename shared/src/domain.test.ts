import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  APPLICATION_STATUSES,
  canTransition,
  isTerminal,
} from './domain.js';

describe('ALLOWED_TRANSITIONS', () => {
  it('has an entry for every status and only targets known statuses', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...APPLICATION_STATUSES].sort());
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) {
      for (const t of targets) expect(APPLICATION_STATUSES).toContain(t);
    }
  });

  it('has no self-loops', () => {
    for (const s of APPLICATION_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('treats MERCHANT_CREATED and REJECTED as the only terminal states', () => {
    expect(APPLICATION_STATUSES.filter(isTerminal).sort()).toEqual(['MERCHANT_CREATED', 'REJECTED']);
  });

  it('every non-initial state is reachable from SUBMITTED', () => {
    const seen = new Set<string>(['SUBMITTED']);
    const queue = ['SUBMITTED'] as (keyof typeof ALLOWED_TRANSITIONS)[];
    while (queue.length) {
      for (const next of ALLOWED_TRANSITIONS[queue.shift()!]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...APPLICATION_STATUSES].sort());
  });

  it('canTransition allows the documented edges and nothing else', () => {
    expect(canTransition('SUBMITTED', 'EXTRACTING')).toBe(true);
    expect(canTransition('MERCHANT_CREATION_FAILED', 'APPROVED')).toBe(true);
    expect(canTransition('SUBMITTED', 'APPROVED')).toBe(false);
    expect(canTransition('REJECTED', 'IN_REVIEW')).toBe(false);
  });
});
