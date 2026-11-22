import type { VerificationKind } from '@app/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { verifications, type Application, type Verification } from '../db/schema.js';
import type { Tx } from '../domain/guards.js';

/** One definition of "the" result, shared by evaluate(), the approval guard and start_verifications. BANK must match the current bank_version. */
export function currentVerification(
  db: Db | Tx,
  app: Pick<Application, 'id' | 'bankVersion'>,
  kind: VerificationKind,
): Verification | undefined {
  return db
    .select()
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
}
