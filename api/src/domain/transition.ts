import { canTransition, type Actor, type ApplicationStatus, type AuditEvent } from '@app/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { applications, auditLog, type Application } from '../db/schema.js';
import { IllegalTransitionError, NotFoundError } from '../errors.js';
import { GUARDS, type Tx } from './guards.js';

export interface TransitionContext {
  actor: Actor;
  event: AuditEvent;
  detail?: unknown;
  now?: number;
}

/**
 * The only writer of applications.status (security.test.ts checks the source).
 * Edge check, guard, update and audit row happen in one transaction; pass a
 * `tx` to make the move part of a larger unit of work.
 */
export function transition(db: Db | Tx, appId: string, to: ApplicationStatus, ctx: TransitionContext): Application {
  const now = ctx.now ?? Date.now();
  return db.transaction(
    (tx) => {
      const app = tx.select().from(applications).where(eq(applications.id, appId)).get();
      if (!app) throw new NotFoundError(`Application ${appId} not found`);

      const from = app.status;
      if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);

      GUARDS[to]?.(tx, app);

      const updated = tx
        .update(applications)
        .set({ status: to, stateEnteredAt: now, updatedAt: now })
        // Compare-and-set on the status we validated against.
        .where(and(eq(applications.id, appId), eq(applications.status, from)))
        .returning()
        .get();
      if (!updated) throw new IllegalTransitionError(from, to);

      tx.insert(auditLog)
        .values({
          applicationId: appId,
          at: now,
          actor: ctx.actor,
          fromState: from,
          toState: to,
          event: ctx.event,
          detail: ctx.detail ?? null,
        })
        .run();

      return updated;
    },
    { behavior: 'immediate' },
  );
}
