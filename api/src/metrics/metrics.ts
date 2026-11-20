import { APPLICATION_STATUSES, type ApplicationStatus, type MetricsDto } from '@app/shared';
import { asc, count, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { applications, auditLog } from '../db/schema.js';

/** A state-changing audit row (to_state not null). */
export interface TransitionRow {
  applicationId: string;
  at: number;
  toState: ApplicationStatus;
}

/** States that count as an exception: the application needed a human or the merchant. */
export const EXCEPTION_STATES: readonly ApplicationStatus[] = ['IN_REVIEW', 'NEEDS_INFO'];

/**
 * Pure metrics over the audit trail. `rows` must be in audit order (by id)
 * per application. A stay in state S runs from the row entering S to the
 * application's next transition; stays still in progress are not averaged
 * (they show up in `current`). Every application has a creation row
 * (to_state SUBMITTED), so the number of distinct applications in `rows` is
 * the total.
 */
export function computeMetrics(rows: readonly TransitionRow[], current: Partial<Record<ApplicationStatus, number>>): MetricsDto {
  const byApp = new Map<string, TransitionRow[]>();
  for (const r of rows) {
    const list = byApp.get(r.applicationId);
    if (list) list.push(r);
    else byApp.set(r.applicationId, [r]);
  }

  const sum = new Map<ApplicationStatus, number>();
  const n = new Map<ApplicationStatus, number>();
  let exceptions = 0;
  for (const list of byApp.values()) {
    for (let i = 0; i + 1 < list.length; i++) {
      const state = list[i]!.toState;
      sum.set(state, (sum.get(state) ?? 0) + (list[i + 1]!.at - list[i]!.at));
      n.set(state, (n.get(state) ?? 0) + 1);
    }
    if (list.some((r) => EXCEPTION_STATES.includes(r.toState))) exceptions++;
  }

  const total = byApp.size;
  return {
    total_applications: total,
    exception_count: exceptions,
    exception_rate: total === 0 ? 0 : exceptions / total,
    states: APPLICATION_STATUSES.map((state) => {
      const completed = n.get(state) ?? 0;
      return { state, avg_ms: completed === 0 ? null : sum.get(state)! / completed, completed, current: current[state] ?? 0 };
    }),
  };
}

/** Load the transitions and current status counts, then computeMetrics(). */
export function getMetrics(db: Db): MetricsDto {
  const rows = db
    .select({ applicationId: auditLog.applicationId, at: auditLog.at, toState: auditLog.toState })
    .from(auditLog)
    .where(isNotNull(auditLog.toState))
    .orderBy(asc(auditLog.applicationId), asc(auditLog.id))
    .all() as TransitionRow[];
  const current = Object.fromEntries(
    db
      .select({ status: applications.status, n: count() })
      .from(applications)
      .groupBy(applications.status)
      .all()
      .map((r) => [r.status, r.n]),
  );
  return computeMetrics(rows, current);
}
