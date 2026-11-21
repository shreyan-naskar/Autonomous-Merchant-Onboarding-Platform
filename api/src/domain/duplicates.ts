import { and, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { ApplicationStatus } from '@app/shared';
import { applications, auditLog, reviewTasks, type Application } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { Tx } from './guards.js';

/*
 * Duplicate detection at submit: a normalized PAN, GSTIN or account + IFSC
 * match opens a POSSIBLE_DUPLICATE task linking the two applications. It never
 * blocks submission; approve.ts holds auto-approval while the task is open.
 */

type DuplicateKey = 'pan' | 'gst' | 'bank';

interface DuplicateMatch {
  applicationId: string;
  status: ApplicationStatus;
  matchedOn: DuplicateKey[];
}

const MAX_DUPLICATE_TASKS = 5;

export const normalizeCode = (v: string | null | undefined) => (v ? v.replace(/\s+/g, '').toUpperCase() : null);
export const normalizeAccount = (v: string | null | undefined) => (v ? v.replace(/[^0-9]/g, '') : null);

// The same normalization in SQL, applied to stored values.
const codeSql = (col: SQLWrapper) => sql`upper(replace(${col}, ' ', ''))`;
const accountSql = sql`replace(replace(${applications.bankAccount}, ' ', ''), '-', '')`;

export function findDuplicates(tx: Db | Tx, app: Application): DuplicateMatch[] {
  const pan = normalizeCode(app.pan);
  const gst = normalizeCode(app.gst);
  const account = normalizeAccount(app.bankAccount);
  const ifsc = normalizeCode(app.ifsc);

  const conds: SQL[] = [];
  if (pan) conds.push(sql`${codeSql(applications.pan)} = ${pan}`);
  if (gst) conds.push(sql`${codeSql(applications.gst)} = ${gst}`);
  if (account && ifsc) conds.push(sql`(${accountSql} = ${account} and ${codeSql(applications.ifsc)} = ${ifsc})`);
  if (conds.length === 0) return [];

  const rows = tx
    .select({ id: applications.id, status: applications.status, pan: applications.pan, gst: applications.gst, bankAccount: applications.bankAccount, ifsc: applications.ifsc })
    .from(applications)
    .where(and(ne(applications.id, app.id), or(...conds)))
    .orderBy(applications.createdAt, applications.id)
    .all();

  return rows.map((r) => ({
    applicationId: r.id,
    status: r.status,
    matchedOn: [
      ...(pan && normalizeCode(r.pan) === pan ? (['pan'] as const) : []),
      ...(gst && normalizeCode(r.gst) === gst ? (['gst'] as const) : []),
      ...(account && ifsc && normalizeAccount(r.bankAccount) === account && normalizeCode(r.ifsc) === ifsc ? (['bank'] as const) : []),
    ],
  }));
}

const LABEL: Record<DuplicateKey, string> = { pan: 'PAN', gst: 'GSTIN', bank: 'bank account + IFSC' };

/** Audits both applications, naming the matched fields, never their values. */
export function flagDuplicates(tx: Tx, app: Application, now: number): DuplicateMatch[] {
  const matches = findDuplicates(tx, app).slice(0, MAX_DUPLICATE_TASKS);
  for (const m of matches) {
    const on = m.matchedOn.map((k) => LABEL[k]).join(', ');
    tx.insert(reviewTasks)
      .values({
        applicationId: app.id,
        reason: 'POSSIBLE_DUPLICATE',
        status: 'OPEN',
        relatedApplicationId: m.applicationId,
        note: `Same ${on} as application ${m.applicationId}`,
        createdAt: now,
      })
      .run();
    const sides = [
      { self: app.id, status: app.status, other: m.applicationId },
      { self: m.applicationId, status: m.status, other: app.id },
    ];
    for (const { self, status, other } of sides) {
      tx.insert(auditLog)
        .values({
          applicationId: self,
          at: now,
          actor: 'system',
          fromState: status,
          toState: null,
          event: 'POSSIBLE_DUPLICATE',
          detail: { related_application_id: other, matched_on: m.matchedOn },
        })
        .run();
    }
  }
  return matches;
}
