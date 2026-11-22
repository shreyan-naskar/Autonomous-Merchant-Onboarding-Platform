import { APPLICATION_STATUSES, type ApplicationStatus, type MetricsDto } from '@app/shared';
import { asc, count, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { applications, auditLog } from '../db/schema.js';

export interface TransitionRow {
  applicationId: string;
  at: number;
  toState: ApplicationStatus;
}

/** An exception is any application that needed a person or the merchant. */
const EXCEPTION_STATES: readonly ApplicationStatus[] = ['IN_REVIEW', 'NEEDS_INFO'];

/** Stays still in progress are not averaged (they count in `current`). `rows` must be in audit order per application. */
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
