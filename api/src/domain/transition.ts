import { canTransition, type Actor, type ApplicationStatus, type AuditEvent } from '@app/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { applications, auditLog, type Application } from '../db/schema.js';
import { IllegalTransitionError, NotFoundError } from '../errors.js';
import { GUARDS } from './guards.js';

export interface TransitionContext {
  actor: Actor;
  event: AuditEvent;
  detail?: unknown;
  /** Injected clock value (epoch ms); defaults to Date.now(). */
  now?: number;
}

/**
 * The only writer of `applications.status`. In one IMMEDIATE transaction:
 * check ALLOWED_TRANSITIONS, run the target state's guard, update status and
 * state_entered_at, and append an audit_log row. Any throw rolls back all of it.
 *
 * @throws NotFoundError, IllegalTransitionError, GuardError
 */
export function transition(db: Db, appId: string, to: ApplicationStatus, ctx: TransitionContext): Application {
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
