import { REQUIRED_CHECKS, type ApplicationStatus } from '@app/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { verifications, type Application } from '../db/schema.js';
import { GuardError } from '../errors.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Runs inside transition()'s DB transaction; throw GuardError to block the move. */
export type Guard = (tx: Tx, app: Application) => void;

/**
 * APPROVED requires every REQUIRED_CHECK to be PASSED on its latest
 * non-superseded attempt, and the BANK check must be for the application's
 * current bank_version (a bank change invalidates earlier results).
 */
export const approvalGuard: Guard = (tx, app) => {
  const missing = REQUIRED_CHECKS.filter((kind) => {
    const latest = tx
      .select({ status: verifications.status })
      .from(verifications)
      .where(
        and(
          eq(verifications.applicationId, app.id),
          eq(verifications.kind, kind),
          eq(verifications.superseded, false),
          kind === 'BANK' ? eq(verifications.bankVersion, app.bankVersion) : undefined,
        ),
      )
      .orderBy(desc(verifications.id))
      .limit(1)
      .get();
    return latest?.status !== 'PASSED';
  });
  if (missing.length > 0) {
    throw new GuardError(`Cannot approve: checks not passed: ${missing.join(', ')}`, {
      missing,
      bankVersion: app.bankVersion,
    });
  }
};

/** Guards keyed by target state. */
export const GUARDS: Partial<Record<ApplicationStatus, Guard>> = {
  APPROVED: approvalGuard,
};
