import { REQUIRED_CHECKS, type ApplicationStatus, type VerificationKind } from '@app/shared';
import type { Db } from '../db/client.js';
import type { Application } from '../db/schema.js';
import { GuardError } from '../errors.js';
import { currentVerification } from '../verification/latest.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Runs inside transition()'s DB transaction; throw GuardError to block the move. */
export type Guard = (tx: Tx, app: Application) => void;

/**
 * APPROVED requires every REQUIRED_CHECK to be PASSED on its latest
 * non-superseded attempt, and the BANK check must be for the application's
 * current bank_version (a bank change invalidates earlier results).
 * The error message names each blocking check and why, for the operator.
 */
export const approvalGuard: Guard = (tx, app) => {
  const blocking: { kind: VerificationKind; status: string }[] = [];
  for (const kind of REQUIRED_CHECKS) {
    const status = currentVerification(tx, app, kind)?.status;
    if (status !== 'PASSED') blocking.push({ kind, status: status ?? 'NOT_STARTED' });
  }
  if (blocking.length > 0) {
    const why = blocking
      .map(({ kind, status }) => {
        const label = status.toLowerCase().replace('_', ' ');
        return kind === 'BANK' ? `BANK is ${label} for bank version ${app.bankVersion}` : `${kind} is ${label}`;
      })
      .join('; ');
    throw new GuardError(`Cannot approve: ${why}. All of ${REQUIRED_CHECKS.join(', ')} must pass first.`, {
      missing: blocking.map((b) => b.kind),
      checks: Object.fromEntries(blocking.map((b) => [b.kind, b.status])),
      bankVersion: app.bankVersion,
    });
  }
};

/** Guards keyed by target state. */
export const GUARDS: Partial<Record<ApplicationStatus, Guard>> = {
  APPROVED: approvalGuard,
};
