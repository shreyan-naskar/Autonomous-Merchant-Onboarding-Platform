import { REQUIRED_CHECKS, type VerificationKind, type VerificationStatus } from '@app/shared';
import { and, eq } from 'drizzle-orm';
import { applications, auditLog, reviewTasks, type Verification } from '../db/schema.js';
import type { Tx } from '../domain/guards.js';
import { transition } from '../domain/transition.js';
import { enqueueJob } from '../jobs/queue.js';
import { currentVerification } from './latest.js';

export type CheckLabel = 'OK' | 'FAILED' | 'PENDING' | 'TIMED_OUT';

export type CheckStates = Record<VerificationKind, VerificationStatus | undefined>;

export type VerificationDecision =
  | { to: 'VERIFIED' }
  | { to: 'IN_REVIEW'; reason: string; failed: VerificationKind[] }
  | { to: null; waiting: VerificationKind[] };

const label = (s: VerificationStatus | undefined): CheckLabel =>
  s === 'PASSED' ? 'OK' : s === 'FAILED' ? 'FAILED' : s === 'TIMED_OUT' ? 'TIMED_OUT' : 'PENDING';

/** Names each check up to the last failed one, e.g. `PAN_OK_GST_FAILED`. Null when nothing failed. */
export function failureReason(states: CheckStates, order: readonly VerificationKind[] = REQUIRED_CHECKS): string | null {
  let lastFailed = -1;
  order.forEach((k, i) => {
    if (states[k] === 'FAILED') lastFailed = i;
  });
  if (lastFailed < 0) return null;
  return order
    .slice(0, lastFailed + 1)
    .map((k) => `${k}_${label(states[k])}`)
    .join('_');
}

export function decideVerification(states: CheckStates, order: readonly VerificationKind[] = REQUIRED_CHECKS): VerificationDecision {
  const reason = failureReason(states, order);
  if (reason) return { to: 'IN_REVIEW', reason, failed: order.filter((k) => states[k] === 'FAILED') };
  if (order.every((k) => states[k] === 'PASSED')) return { to: 'VERIFIED' };
  return { to: null, waiting: order.filter((k) => states[k] !== 'PASSED') };
}

export type EvaluateResult =
  | { action: 'none'; reason: string }
  | { action: 'VERIFIED' }
  | { action: 'IN_REVIEW'; reason: string };

function describeChecks(current: Partial<Record<VerificationKind, Verification>>): string {
  return REQUIRED_CHECKS.map((k) => {
    const v = current[k];
    if (!v) return `${k}: not started`;
    const raw = v.rawResponse as { result?: { reason?: string } } | null;
    const why = raw?.result?.reason ? ` (${raw.result.reason})` : '';
    const score = v.score !== null ? ` score ${v.score}` : '';
    return `${k}: ${v.status.toLowerCase()}${why}${score}, attempt ${v.attempt}`;
  }).join('; ');
}

/** A BANK_CHANGED task is only a flag; once every check passes again it resolves itself so it does not linger in the queue. */
function resolveBankChangedTasks(tx: Tx, appId: string, bankVersion: number, now: number) {
  const resolved = tx
    .update(reviewTasks)
    .set({
      status: 'RESOLVED',
      resolution: 'AUTO_REVERIFIED',
      resolutionNote: `Bank details re-verified (bank version ${bankVersion})`,
      resolvedAt: now,
    })
    .where(and(eq(reviewTasks.applicationId, appId), eq(reviewTasks.reason, 'BANK_CHANGED'), eq(reviewTasks.status, 'OPEN')))
    .returning({ id: reviewTasks.id })
    .all();
  if (resolved.length === 0) return;
  tx.insert(auditLog)
    .values({
      applicationId: appId,
      at: now,
      actor: 'system',
      fromState: 'VERIFIED',
      toState: null,
      event: 'REVIEW_TASK_AUTO_RESOLVED',
      detail: { task_ids: resolved.map((r) => r.id), reason: 'BANK_CHANGED', bank_version: bankVersion },
    })
    .run();
}

/** Only acts in VERIFYING: callbacks that arrive while a person is reviewing are recorded but never move the application. */
export function evaluate(tx: Tx, appId: string, now: number): EvaluateResult {
  const app = tx.select().from(applications).where(eq(applications.id, appId)).get();
  if (!app) return { action: 'none', reason: 'application not found' };
  if (app.status !== 'VERIFYING') return { action: 'none', reason: `status is ${app.status}` };

  const current: Partial<Record<VerificationKind, Verification>> = {};
  const states = {} as CheckStates;
  for (const kind of REQUIRED_CHECKS) {
    const v = currentVerification(tx, app, kind);
    if (v) current[kind] = v;
    states[kind] = v?.status;
  }
  const checks = Object.fromEntries(REQUIRED_CHECKS.map((k) => [k, states[k] ?? null]));
  const decision = decideVerification(states);

  if (decision.to === 'VERIFIED') {
    transition(tx, appId, 'VERIFIED', {
      actor: 'system',
      event: 'ALL_CHECKS_PASSED',
      detail: { checks, risk_score: current.RISK?.score ?? null, bank_version: app.bankVersion },
      now,
    });
    enqueueJob(tx, 'approve', { application_id: appId }, { now });
    resolveBankChangedTasks(tx, appId, app.bankVersion, now);
    return { action: 'VERIFIED' };
  }

  if (decision.to === 'IN_REVIEW') {
    transition(tx, appId, 'IN_REVIEW', {
      actor: 'system',
      event: 'VERIFICATION_FAILED',
      detail: { reason: decision.reason, failed: decision.failed, checks },
      now,
    });
    tx.insert(reviewTasks)
      .values({
        applicationId: appId,
        reason: decision.reason,
        status: 'OPEN',
        note: `Verification failed: ${decision.failed.join(', ')}. ${describeChecks(current)}`,
        createdAt: now,
      })
      .run();
    return { action: 'IN_REVIEW', reason: decision.reason };
  }

  return { action: 'none', reason: `waiting for ${decision.waiting.join(', ')}` };
}
