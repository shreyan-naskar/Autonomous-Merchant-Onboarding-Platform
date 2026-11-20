import type { Tx } from '../domain/guards.js';

export type EvaluateResult = { action: 'none'; reason: string };

/** Decide the application's next state from its verification results (Phase 4.6). */
export function evaluate(_tx: Tx, _appId: string, _now: number): EvaluateResult {
  return { action: 'none', reason: 'not implemented' };
}
