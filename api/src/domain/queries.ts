import { REQUIRED_CHECKS, type ApplicationStatus } from '@app/shared';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  applications,
  auditLog,
  callbackEvents,
  documents,
  extractedFields,
  reviewTasks,
  verifications,
  type Application,
} from '../db/schema.js';
import { currentVerification } from '../verification/latest.js';

/** Raw rows (unmasked). Only http/dto.ts turns these into responses. */
export type ApplicationListRow = Application & { openReviewCount: number };

export interface ApplicationDetailRows {
  app: ApplicationListRow;
  documents: (typeof documents.$inferSelect)[];
  extractedFields: (typeof extractedFields.$inferSelect)[];
  verifications: (typeof verifications.$inferSelect)[];
  reviewTasks: (typeof reviewTasks.$inferSelect)[];
  callbacks: (typeof callbackEvents.$inferSelect)[];
  /** Ids of the verification rows currentVerification() picks, one per kind at most. */
  currentVerificationIds: Set<number>;
  auditLog: (typeof auditLog.$inferSelect)[];
}

// Correlated subquery written with explicit qualifiers: Drizzle renders column
// refs unqualified in single-table selects, so `${applications.id}` would bind
// to review_tasks.id inside the subquery and the count would always be 0.
const openReviewCount = sql<number>`(
  select count(*) from review_tasks rt
  where rt.application_id = "applications"."id" and rt.status = 'OPEN'
)`.mapWith(Number);

export function listApplications(
  db: Db,
  { status, limit = 100 }: { status?: ApplicationStatus; limit?: number } = {},
): ApplicationListRow[] {
  const q = db
    .select({ app: applications, openReviewCount })
    .from(applications)
    .where(status ? eq(applications.status, status) : undefined)
    .orderBy(desc(applications.createdAt), desc(applications.id))
    .limit(limit);
  return q.all().map((r) => ({ ...r.app, openReviewCount: r.openReviewCount }));
}

export type ReviewQueueRow = typeof reviewTasks.$inferSelect & {
  merchantName: string;
  applicationStatus: ApplicationStatus;
};

/** Review tasks with their application's name and status; oldest first (a queue). */
export function listReviewTasks(
  db: Db,
  { status = 'OPEN', limit = 200 }: { status?: 'OPEN' | 'RESOLVED'; limit?: number } = {},
): ReviewQueueRow[] {
  return db
    .select({ task: reviewTasks, merchantName: applications.merchantName, applicationStatus: applications.status })
    .from(reviewTasks)
    .innerJoin(applications, eq(applications.id, reviewTasks.applicationId))
    .where(eq(reviewTasks.status, status))
    .orderBy(status === 'OPEN' ? asc(reviewTasks.id) : desc(reviewTasks.id))
    .limit(limit)
    .all()
    .map((r) => ({ ...r.task, merchantName: r.merchantName, applicationStatus: r.applicationStatus }));
}

export function getApplicationDetail(db: Db, id: string): ApplicationDetailRows | undefined {
  const row = db
    .select({ app: applications, openReviewCount })
    .from(applications)
    .where(eq(applications.id, id))
    .get();
  if (!row) return undefined;
  return {
    app: { ...row.app, openReviewCount: row.openReviewCount },
    documents: db.select().from(documents).where(eq(documents.applicationId, id)).orderBy(asc(documents.id)).all(),
    extractedFields: db
      .select()
      .from(extractedFields)
      .where(eq(extractedFields.applicationId, id))
      .orderBy(asc(extractedFields.id))
      .all(),
    verifications: db
      .select()
      .from(verifications)
      .where(eq(verifications.applicationId, id))
      .orderBy(asc(verifications.id))
      .all(),
    reviewTasks: db
      .select()
      .from(reviewTasks)
      .where(eq(reviewTasks.applicationId, id))
      .orderBy(asc(reviewTasks.id))
      .all(),
    currentVerificationIds: new Set(
      REQUIRED_CHECKS.map((k) => currentVerification(db, row.app, k)?.id).filter((x): x is number => x !== undefined),
    ),
    callbacks: db
      .select()
      .from(callbackEvents)
      .where(eq(callbackEvents.applicationId, id))
      .orderBy(asc(callbackEvents.id))
      .all(),
    auditLog: db.select().from(auditLog).where(eq(auditLog.applicationId, id)).orderBy(asc(auditLog.id)).all(),
  };
}
